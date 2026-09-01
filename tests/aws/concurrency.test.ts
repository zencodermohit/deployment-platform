/**
 * The M3 exit criterion, proved against real DynamoDB.
 *
 * The unit tests mock the SDK, so they can only assert the *shape* of the
 * request. These assert the *semantics*: that when several dispatchers race for
 * the same deployment, DynamoDB lets exactly one through.
 *
 * That guarantee is what makes the whole pipeline safe under SQS's
 * at-least-once delivery. It is the single most load-bearing claim in the
 * architecture, so it gets tested against the real thing.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  computeDeadline,
  deploymentKey,
  generateDeploymentId,
  generateProjectId,
  type Deployment,
} from '@platform/core';
import {
  claimDeployment,
  createDeployment,
  failDeployment,
  findOverdueDeployments,
  getDeploymentById,
  listDeployments,
  transition,
} from '../../apps/api/src/repository/deployments.js';
import { documentClient, tableName } from '../../apps/api/src/repository/table.js';

const createdKeys: { PK: string; SK: string }[] = [];

function makeDeployment(overrides: Partial<Deployment> = {}): Omit<Deployment, 'schemaVersion'> {
  const projectId = overrides.projectId ?? generateProjectId();
  const deploymentId = overrides.deploymentId ?? generateDeploymentId();
  const createdAt = overrides.createdAt ?? new Date().toISOString();

  return {
    projectId,
    deploymentId,
    createdAt,
    userId: 'usr_test',
    status: 'QUEUED',
    repositoryUrl: 'https://github.com/octocat/hello-world',
    owner: 'octocat',
    repo: 'hello-world',
    branch: 'main',
    commitSha: 'a'.repeat(40),
    commitMessage: 'test',
    trigger: 'manual',
    framework: null,
    artifactPrefix: `projects/${projectId}/deployments/${deploymentId}`,
    hostname: `${deploymentId.replace(/_/g, '-')}.example.com`,
    taskArn: null,
    logStreamName: `builds/${deploymentId}`,
    statusTokenHash: null,
    startedAt: null,
    finishedAt: null,
    deadlineAt: computeDeadline(createdAt, 600),
    durationMs: null,
    artifactBytes: null,
    fileCount: null,
    error: null,
    retryOfDeploymentId: null,
    ...overrides,
  };
}

async function seed(overrides: Partial<Deployment> = {}): Promise<Deployment> {
  const input = makeDeployment(overrides);
  const created = await createDeployment({ deployment: input, buildTimeoutSec: 600 });
  createdKeys.push(deploymentKey(created.projectId, created.createdAt, created.deploymentId));
  return created;
}

async function readRaw(d: Deployment): Promise<Record<string, unknown> | undefined> {
  const result = await documentClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: deploymentKey(d.projectId, d.createdAt, d.deploymentId),
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

beforeEach(() => {
  expect(tableName()).toMatch(/-test$/);
});

afterAll(async () => {
  for (const key of createdKeys) {
    await documentClient().send(new DeleteCommand({ TableName: tableName(), Key: key }));
  }
});

describe('the claim, under real concurrency', () => {
  it('lets exactly one of ten simultaneous dispatchers win', async () => {
    const deployment = await seed();

    // Ten dispatchers, all handed the same message at the same moment.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        claimDeployment(deployment, { taskArn: `arn:task/${i}` }),
      ),
    );

    const winners = results.filter((r) => r.won);
    const losers = results.filter((r) => !r.won);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);

    // Losers must fail quietly, not throw — they simply delete their message.
    for (const loser of losers) {
      expect(loser.deployment).toBeNull();
    }

    // And exactly one task ARN was recorded, so only one container would start.
    const stored = await readRaw(deployment);
    expect(stored?.['status']).toBe('PROVISIONING');
    expect(String(stored?.['taskArn'])).toMatch(/^arn:task\/\d$/);
  });

  it('refuses a second claim even long after the first', async () => {
    const deployment = await seed();

    const first = await claimDeployment(deployment);
    const second = await claimDeployment(deployment);

    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
  });

  it('lets a redelivered message find the work already finished', async () => {
    const deployment = await seed();
    await claimDeployment(deployment);
    await transition({ deployment, to: 'BUILDING', by: 'container' });
    await transition({ deployment, to: 'UPLOADING', by: 'container' });
    await transition({ deployment, to: 'DEPLOYED', by: 'container' });

    // SQS redelivers hours later. Nothing should happen.
    const late = await claimDeployment(deployment);
    expect(late.won).toBe(false);

    const stored = await readRaw(deployment);
    expect(stored?.['status']).toBe('DEPLOYED');
  });
});

describe('the state machine, enforced by the database', () => {
  it('walks the happy path', async () => {
    const deployment = await seed();

    for (const [to, by] of [
      ['PROVISIONING', 'dispatcher'],
      ['BUILDING', 'container'],
      ['UPLOADING', 'container'],
      ['DEPLOYED', 'container'],
    ] as const) {
      const result = await transition({ deployment, to, by });
      expect(result.won, `${to}`).toBe(true);
      expect(result.deployment?.status).toBe(to);
    }
  });

  it('rejects a skipped step at the database, not in code', async () => {
    const deployment = await seed();
    // QUEUED -> BUILDING is legal for nobody; the condition must refuse it.
    const result = await transition({ deployment, to: 'UPLOADING', by: 'container' });
    expect(result.won).toBe(false);

    const stored = await readRaw(deployment);
    expect(stored?.['status']).toBe('QUEUED');
  });

  it('refuses to move a deployment that already failed', async () => {
    const deployment = await seed();
    await failDeployment(deployment, 'container', { code: 'BUILD_FAILED', message: 'exit 13' });

    const result = await transition({ deployment, to: 'DEPLOYED', by: 'container' });
    expect(result.won).toBe(false);
  });

  it('lets exactly one of a racing success and failure win', async () => {
    const deployment = await seed();
    await claimDeployment(deployment);
    await transition({ deployment, to: 'BUILDING', by: 'container' });
    await transition({ deployment, to: 'UPLOADING', by: 'container' });

    // The genuinely conflicting case: from UPLOADING, the container reports
    // success at the same moment the reconciler decides the task died. Both
    // start from the same state and lead to different terminal states, so
    // exactly one must land.
    const [success, failure] = await Promise.all([
      transition({ deployment, to: 'DEPLOYED', by: 'container' }),
      failDeployment(deployment, 'reconciler', { code: 'OUT_OF_MEMORY', message: 'exit 137' }),
    ]);

    expect([success.won, failure.won].filter(Boolean)).toHaveLength(1);

    // Whichever won, the deployment sits in exactly one terminal state and has
    // left the in-flight index.
    const stored = await readRaw(deployment);
    expect(['DEPLOYED', 'FAILED']).toContain(stored?.['status']);
    expect(stored?.['gsi2pk']).toBeUndefined();
  });

  it('allows failing after a step that already succeeded', async () => {
    // Not a race, and deliberately NOT mutually exclusive: a build can succeed
    // and then fail during upload. An earlier version of the test above assumed
    // BUILDING->UPLOADING and ->FAILED could not both win. They can, and should.
    const deployment = await seed();
    await claimDeployment(deployment);
    await transition({ deployment, to: 'BUILDING', by: 'container' });

    const advanced = await transition({ deployment, to: 'UPLOADING', by: 'container' });
    const failed = await failDeployment(deployment, 'container', {
      code: 'UPLOAD_FAILED',
      message: 'S3 rejected the artifact',
    });

    expect(advanced.won).toBe(true);
    expect(failed.won).toBe(true);
  });
});

describe('the sparse in-flight index', () => {
  it('carries live deployments and drops terminal ones', async () => {
    const deployment = await seed();

    let raw = await readRaw(deployment);
    expect(raw?.['gsi2pk']).toBe('INFLIGHT');
    expect(raw?.['gsi2sk']).toBe(deployment.deadlineAt);

    await claimDeployment(deployment);
    raw = await readRaw(deployment);
    expect(raw?.['gsi2pk'], 'still live after the claim').toBe('INFLIGHT');

    await transition({ deployment, to: 'BUILDING', by: 'container' });
    await transition({ deployment, to: 'UPLOADING', by: 'container' });
    await transition({ deployment, to: 'DEPLOYED', by: 'container' });

    raw = await readRaw(deployment);
    expect(raw?.['gsi2pk'], 'index keys removed on the terminal move').toBeUndefined();
    expect(raw?.['gsi2sk']).toBeUndefined();
    expect(raw?.['status']).toBe('DEPLOYED');
  });

  it('drops them on failure as well', async () => {
    const deployment = await seed();
    await failDeployment(deployment, 'sweeper', { code: 'TIMEOUT', message: 'past deadline' });

    const raw = await readRaw(deployment);
    expect(raw?.['gsi2pk']).toBeUndefined();
  });
});

describe('the sweeper query', () => {
  it('finds a deployment past its deadline and ignores one that is not', async () => {
    const past = await seed({
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      deadlineAt: new Date(Date.now() - 1_800_000).toISOString(),
    });
    const future = await seed({
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // GSI reads are always eventually consistent, so poll rather than assume.
    let overdue: Awaited<ReturnType<typeof findOverdueDeployments>> = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      overdue = await findOverdueDeployments();
      if (overdue.some((d) => d.deploymentId === past.deploymentId)) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const ids = overdue.map((d) => d.deploymentId);
    expect(ids, 'past-deadline deployment found').toContain(past.deploymentId);
    expect(ids, 'future-deadline deployment not swept').not.toContain(future.deploymentId);

    // The projection must carry what the sweeper needs to act.
    const found = overdue.find((d) => d.deploymentId === past.deploymentId)!;
    expect(found.projectId).toBe(past.projectId);
    expect(found.createdAt).toBe(past.createdAt);
    expect(found.status).toBe('QUEUED');
  });
});

describe('reads and listing', () => {
  it('finds a deployment by id alone, without knowing its project', async () => {
    const deployment = await seed();

    let found: Deployment | null = null;
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      found = await getDeploymentById(deployment.deploymentId);
      if (!found) await new Promise((r) => setTimeout(r, 500));
    }

    expect(found?.deploymentId).toBe(deployment.deploymentId);
    expect(found?.projectId).toBe(deployment.projectId);
  });

  it('lists a project newest-first and scopes to that project alone', async () => {
    const projectId = generateProjectId();
    const base = Date.now();

    const older = await seed({ projectId, createdAt: new Date(base - 60_000).toISOString() });
    const newer = await seed({ projectId, createdAt: new Date(base).toISOString() });
    const other = await seed();

    const { deployments } = await listDeployments(projectId, 20);
    const ids = deployments.map((d) => d.deploymentId);

    expect(ids[0]).toBe(newer.deploymentId);
    expect(ids[1]).toBe(older.deploymentId);
    expect(ids).not.toContain(other.deploymentId);
  });

  it('paginates without repeating or losing a deployment', async () => {
    const projectId = generateProjectId();
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await seed({ projectId, createdAt: new Date(base - i * 1000).toISOString() });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result: Awaited<ReturnType<typeof listDeployments>> = await listDeployments(
        projectId,
        2,
        cursor ?? undefined,
      );
      seen.push(...result.deployments.map((d) => d.deploymentId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe('creation is idempotent', () => {
  it('refuses to write the same deployment twice', async () => {
    const input = makeDeployment();
    const created = await createDeployment({ deployment: input, buildTimeoutSec: 600 });
    createdKeys.push(deploymentKey(created.projectId, created.createdAt, created.deploymentId));

    // Match on the error NAME, not the message: DynamoDB's human-readable text
    // is "The conditional request failed", which says nothing greppable.
    await expect(
      createDeployment({ deployment: input, buildTimeoutSec: 600 }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });
});
