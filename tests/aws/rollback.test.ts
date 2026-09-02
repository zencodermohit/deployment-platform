/**
 * Rollback: the claim that immutable artifacts make it a pointer swap.
 *
 * docs/00-scope.md lists "rollback changes the served content without running a
 * build" as a success criterion, and ADR-0005 says no cache invalidation is
 * needed because the prefix changes. Both were only claims until this file.
 *
 * The edge write is stubbed here — CloudFront's key-value store is global, and
 * a test that mutated it would fight the live routing table. What is asserted
 * is the contract: promote writes the project key to the chosen deployment's
 * prefix, changes nothing else, and starts no build.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import {
  documentClient,
  getDeploymentById,
  patchDeployment,
  tableName,
  transition,
} from '@platform/data';

const writes: { key: string; prefix: string }[] = [];

// Must be mocked before the handlers are imported, since they capture the
// module at load time.
vi.mock('../../apps/api/src/edge.js', () => ({
  putRoute: (route: { key: string; prefix: string }) => {
    writes.push(route);
    return Promise.resolve();
  },
}));

const { handler } = await import('../../apps/api/src/main.js');
const { projectRouteKey } = await import('../../apps/api/src/handlers/actions.js');

const USER = 'usr_rollback';

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Res> {
  const result = await handler({
    version: '2.0',
    rawPath: path,
    headers: { 'x-debug-user': USER, ...extraHeaders },
    queryStringParameters: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { requestId: 'test', http: { method, path } },
  });
  return { status: result.statusCode, body: JSON.parse(result.body) };
}

async function purge(pk: string): Promise<void> {
  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ConsistentRead: true,
    }),
  );
  for (const item of result.Items ?? []) {
    await documentClient().send(
      new DeleteCommand({ TableName: tableName(), Key: { PK: item['PK'], SK: item['SK'] } }),
    );
  }
}

const projects: string[] = [];

beforeAll(() => {
  expect(tableName()).toMatch(/-test$/);
  process.env['ALLOW_DEBUG_AUTH'] = 'true';
  process.env['CLOUDFRONT_DOMAIN'] = 'example.cloudfront.net';
  delete process.env['DEV_USER_ID'];
});

beforeEach(async () => {
  writes.length = 0;
  await purge(`USER#${USER}`);
});

afterAll(async () => {
  await purge(`USER#${USER}`);
  for (const p of projects) await purge(`PROJECT#${p}`);
  delete process.env['ALLOW_DEBUG_AUTH'];
});

/**
 * Create a deployment and drive it to DEPLOYED through the REAL status
 * endpoint.
 *
 * An earlier version called transition() directly, which skipped the status
 * handler — and the auto-promote lives there, so the test for it failed while
 * the code was correct. Going through the endpoint also exercises the
 * per-deployment token auth on the way past.
 */
async function deployed(projectId: string): Promise<string> {
  const created = await call('POST', `/projects/${projectId}/deployments`);
  expect(created.status).toBe(202);
  const id = created.body.deploymentId as string;

  const ref = await getDeploymentById(id);
  if (!ref) throw new Error('deployment vanished');

  // Stand in for the dispatcher: claim it, and plant a status token the way a
  // real dispatch would.
  const token = `stk_${'a'.repeat(64)}`;
  await patchDeployment(ref, { statusTokenHash: createHash('sha256').update(token).digest('hex') });
  await transition({ deployment: ref, to: 'PROVISIONING', by: 'dispatcher' });

  const auth = { authorization: `Bearer ${token}` };
  for (const status of ['BUILDING', 'UPLOADING', 'DEPLOYED'] as const) {
    const res = await call(
      'POST',
      `/internal/deployments/${id}/status`,
      { status },
      auth,
    );
    expect(res.status, `${status}: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.applied).toBe(true);
  }

  return id;
}

async function newProject(): Promise<string> {
  const res = await call('POST', '/projects', {
    name: 'rollback demo',
    repositoryUrl: 'https://github.com/octocat/Spoon-Knife',
  });
  expect(res.status).toBe(201);
  projects.push(res.body.projectId as string);
  return res.body.projectId as string;
}

describe('promote and rollback', () => {
  it('rolls back to an earlier deployment without running a build', async () => {
    const projectId = await newProject();

    const first = await deployed(projectId);
    const second = await deployed(projectId);

    writes.length = 0;

    const res = await call('POST', `/deployments/${first}/promote`);

    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(first);
    // The headline claim: no container, no queue, no rebuild.
    expect(res.body.rebuilt).toBe(false);
    // Milliseconds, where a rebuild would be minutes.
    expect(res.body.tookMs).toBeLessThan(5000);

    // Exactly one edge write, pointing the project key at the OLDER prefix.
    const projectWrite = writes.find((w) => w.key === projectRouteKey(projectId));
    expect(projectWrite?.prefix).toContain(first);
    expect(projectWrite?.prefix).not.toContain(second);

    // And the project now records the older deployment as active.
    const project = await call('GET', `/projects/${projectId}`);
    expect(project.body.activeDeploymentId).toBe(first);
  });

  it('leaves both deployments untouched — the artifacts never move', async () => {
    const projectId = await newProject();
    const first = await deployed(projectId);
    const second = await deployed(projectId);

    const before = await call('GET', `/deployments/${second}`);
    await call('POST', `/deployments/${first}/promote`);
    const after = await call('GET', `/deployments/${second}`);

    // Rolling away from a deployment does not fail it, delete it, or change it
    // in any way. It stays DEPLOYED and reachable at its own URL forever.
    expect(after.body.status).toBe('DEPLOYED');
    expect(after.body).toEqual(before.body);
  });

  it('refuses to promote a build that never succeeded', async () => {
    const projectId = await newProject();
    const created = await call('POST', `/projects/${projectId}/deployments`);

    const res = await call('POST', `/deployments/${created.body.deploymentId}/promote`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/only a deployed build/i);
  });

  it('auto-promotes the newest successful deployment', async () => {
    const projectId = await newProject();
    await deployed(projectId);

    // A successful build points the project key at itself, the way a push to
    // production does — rollback is the exception, not the rule.
    expect(writes.some((w) => w.key === projectRouteKey(projectId))).toBe(true);
  });
});

describe('retry', () => {
  it('creates a NEW deployment and leaves the failed one visible', async () => {
    const projectId = await newProject();
    const created = await call('POST', `/projects/${projectId}/deployments`, { branch: 'main' });
    const originalId = created.body.deploymentId as string;

    const ref = await getDeploymentById(originalId);
    await transition({
      deployment: ref!,
      to: 'FAILED',
      by: 'api',
      patch: { error: { code: 'BUILD_FAILED', message: 'exit 13' } },
    });

    const retry = await call('POST', `/deployments/${originalId}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.body.deploymentId).not.toBe(originalId);

    // The failure stays in history rather than being overwritten.
    const original = await call('GET', `/deployments/${originalId}`);
    expect(original.body.status).toBe('FAILED');
    expect(original.body.error.code).toBe('BUILD_FAILED');
  });

  it('refuses to retry something still running', async () => {
    const projectId = await newProject();
    const created = await call('POST', `/projects/${projectId}/deployments`);

    const res = await call('POST', `/deployments/${created.body.deploymentId}/retry`);
    expect(res.status).toBe(409);
  });
});

describe('cancel', () => {
  it('cancels a queued deployment', async () => {
    const projectId = await newProject();
    const created = await call('POST', `/projects/${projectId}/deployments`);

    const res = await call('POST', `/deployments/${created.body.deploymentId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  it('refuses once the build is running', async () => {
    const projectId = await newProject();
    const created = await call('POST', `/projects/${projectId}/deployments`);
    const ref = await getDeploymentById(created.body.deploymentId as string);

    await transition({ deployment: ref!, to: 'PROVISIONING', by: 'dispatcher' });
    await transition({ deployment: ref!, to: 'BUILDING', by: 'container' });

    // Stopping a running task would leave a half-uploaded prefix, and it will
    // finish or time out within minutes anyway.
    const res = await call('POST', `/deployments/${created.body.deploymentId}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/before it starts building/i);
  });
});
