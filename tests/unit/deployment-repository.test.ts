/**
 * Tests for the DynamoDB request the repository builds.
 *
 * IMPORTANT LIMITATION, stated up front: these mock the AWS SDK, so they prove
 * the *shape* of the request — the right ConditionExpression, the REMOVE on a
 * terminal move, descending order on the list query. They cannot prove the
 * *semantics*: that DynamoDB actually lets exactly one of two concurrent
 * claims win. Mocking the conditional write and then asserting the conditional
 * write works would be circular.
 *
 * The concurrency proof needs a real table and lives in tests/integration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  claimDeployment,
  createDeployment,
  failDeployment,
  findOverdueDeployments,
  listDeployments,
  transition,
} from '../../apps/api/src/repository/deployments.js';
import { resetClient } from '../../apps/api/src/repository/table.js';
import { SCHEMA_VERSION, type Deployment } from '@platform/core';

const ddb = mockClient(DynamoDBDocumentClient);

const REF = {
  projectId: 'prj_1',
  createdAt: '2026-09-01T10:00:00.000Z',
  deploymentId: 'dep_9',
  deadlineAt: '2026-09-01T10:12:00.000Z',
};

function sampleDeployment(): Omit<Deployment, 'schemaVersion' | 'deadlineAt'> {
  return {
    ...REF,
    userId: 'usr_1',
    status: 'QUEUED',
    repositoryUrl: 'https://github.com/octocat/hello-world',
    owner: 'octocat',
    repo: 'hello-world',
    branch: 'main',
    commitSha: 'a'.repeat(40),
    commitMessage: 'fix nav',
    trigger: 'manual',
    framework: null,
    artifactPrefix: 'projects/prj_1/deployments/dep_9',
    hostname: 'dep-9.example.com',
    taskArn: null,
    logStreamName: 'builds/dep_9',
    statusTokenHash: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    artifactBytes: null,
    fileCount: null,
    error: null,
    retryOfDeploymentId: null,
  };
}

beforeEach(() => {
  ddb.reset();
  resetClient();
  process.env['TABLE_NAME'] = 'platform-test';
});

afterEach(() => {
  delete process.env['TABLE_NAME'];
});

describe('createDeployment', () => {
  it('writes keys, GSI keys, and the in-flight marker together', async () => {
    ddb.on(PutCommand).resolves({});
    await createDeployment({ deployment: sampleDeployment(), buildTimeoutSec: 600 });

    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item as Record<string, unknown>;

    expect(item['PK']).toBe('PROJECT#prj_1');
    expect(item['SK']).toBe('DEP#2026-09-01T10:00:00.000Z#dep_9');
    expect(item['gsi1pk']).toBe('DEP#dep_9');
    expect(item['gsi2pk']).toBe('INFLIGHT');
    expect(item['gsi2sk']).toBe(REF.deadlineAt);
    expect(item['entity']).toBe('Deployment');
    expect(item['schemaVersion']).toBe(SCHEMA_VERSION);
  });

  it('refuses to overwrite an existing deployment', async () => {
    ddb.on(PutCommand).resolves({});
    await createDeployment({ deployment: sampleDeployment(), buildTimeoutSec: 600 });

    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.ConditionExpression).toBe(
      'attribute_not_exists(PK)',
    );
  });

  it('derives the deadline from the build timeout when none is given', async () => {
    ddb.on(PutCommand).resolves({});
    const created = await createDeployment({
      deployment: { ...sampleDeployment(), deadlineAt: undefined },
      buildTimeoutSec: 600,
    });
    expect(created.deadlineAt).toBe('2026-09-01T10:12:00.000Z');
  });
});

describe('the claim — QUEUED to PROVISIONING', () => {
  it('conditions the write on the deployment still being QUEUED', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { status: 'PROVISIONING' } });
    const result = await claimDeployment(REF, { taskArn: 'arn:aws:ecs:...:task/abc' });

    expect(result.won).toBe(true);

    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('#status IN (:from0)');
    expect(input.ExpressionAttributeValues![':from0']).toBe('QUEUED');
    expect(input.ExpressionAttributeValues![':to']).toBe('PROVISIONING');
    expect(input.ExpressionAttributeValues![':taskArn']).toBe('arn:aws:ecs:...:task/abc');
  });

  it('reports a lost race as won:false rather than throwing', async () => {
    const err = new Error('condition failed');
    err.name = 'ConditionalCheckFailedException';
    ddb.on(UpdateCommand).rejects(err);

    const result = await claimDeployment(REF);

    expect(result.won).toBe(false);
    expect(result.deployment).toBeNull();
  });

  it('still throws on a genuine failure, so real problems are not swallowed', async () => {
    const err = new Error('throughput exceeded');
    err.name = 'ProvisionedThroughputExceededException';
    ddb.on(UpdateCommand).rejects(err);

    await expect(claimDeployment(REF)).rejects.toThrow(/throughput/);
  });

  it('keeps the in-flight marker, since PROVISIONING is not terminal', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await claimDeployment(REF);

    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain('#gsi2pk = :inflight');
    expect(input.UpdateExpression).not.toContain('REMOVE');
  });
});

describe('terminal transitions', () => {
  it('REMOVEs the sparse-index keys on DEPLOYED', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await transition({ deployment: REF, to: 'DEPLOYED', by: 'container' });

    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain('REMOVE gsi2pk, gsi2sk');
    expect(input.UpdateExpression).not.toContain(':inflight');
    expect(input.ConditionExpression).toBe('#status IN (:from0)');
    expect(input.ExpressionAttributeValues![':from0']).toBe('UPLOADING');
  });

  it('REMOVEs them on FAILED too, from any live state', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await failDeployment(REF, 'reconciler', { code: 'OUT_OF_MEMORY', message: 'exit 137' });

    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain('REMOVE gsi2pk, gsi2sk');

    // FAILED is reachable from four states, so the condition lists all four.
    const froms = Object.entries(input.ExpressionAttributeValues!)
      .filter(([k]) => k.startsWith(':from'))
      .map(([, v]) => v)
      .sort();
    expect(froms).toEqual(['BUILDING', 'PROVISIONING', 'QUEUED', 'UPLOADING']);
  });

  it('records the error payload', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await failDeployment(REF, 'container', { code: 'BUILD_FAILED', message: 'exit 13', exitCode: 13 });

    const values = ddb.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues!;
    expect(values[':error']).toEqual({ code: 'BUILD_FAILED', message: 'exit 13', exitCode: 13 });
    expect(values[':finishedAt']).toBeTypeOf('string');
  });

  it('refuses a move no actor is allowed to make', async () => {
    await expect(
      transition({ deployment: REF, to: 'QUEUED', by: 'container' }),
    ).rejects.toThrow();
  });
});

describe('listDeployments', () => {
  it('queries one project partition, newest first', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await listDeployments('prj_1');

    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :sk)');
    expect(input.ExpressionAttributeValues![':pk']).toBe('PROJECT#prj_1');
    expect(input.ExpressionAttributeValues![':sk']).toBe('DEP#');
    expect(input.ScanIndexForward).toBe(false);
    expect(input.IndexName).toBeUndefined();
  });

  it('clamps the page size', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await listDeployments('prj_1', 5000);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.Limit).toBe(100);

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await listDeployments('prj_1', 0);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.Limit).toBe(1);
  });

  it('returns a cursor only when more pages exist', async () => {
    ddb.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { PK: 'x', SK: 'y' } });
    expect((await listDeployments('prj_1')).nextCursor).toBeTypeOf('string');

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect((await listDeployments('prj_1')).nextCursor).toBeNull();
  });

  it('round-trips its own cursor', async () => {
    ddb.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { PK: 'PROJECT#prj_1', SK: 'DEP#z' } });
    const first = await listDeployments('prj_1');

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await listDeployments('prj_1', 20, first.nextCursor!);

    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExclusiveStartKey).toEqual({
      PK: 'PROJECT#prj_1',
      SK: 'DEP#z',
    });
  });
});

describe('findOverdueDeployments', () => {
  it('reads the sparse index rather than scanning the table', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await findOverdueDeployments(new Date('2026-09-01T11:00:00.000Z'));

    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.IndexName).toBe('gsi2');
    expect(input.KeyConditionExpression).toBe('gsi2pk = :pk AND gsi2sk < :now');
    expect(input.ExpressionAttributeValues![':pk']).toBe('INFLIGHT');
    expect(input.ExpressionAttributeValues![':now']).toBe('2026-09-01T11:00:00.000Z');
  });
});
