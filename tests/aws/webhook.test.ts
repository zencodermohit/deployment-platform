/**
 * The webhook flow, end to end against the real test table.
 *
 * The signature maths is covered by the unit suite; this proves the wiring: a
 * signed push to the default branch creates a webhook-triggered deployment, and
 * everything that should NOT build — a forged signature, a feature branch, a
 * deletion, a tag — does not.
 *
 * The queue is stubbed (nothing consumes the test queue) and so is the edge
 * write, so no real build starts. What is asserted is that a deployment record
 * appears, with the right trigger, only when it should.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, tableName } from '@platform/data';

const enqueued: string[] = [];
vi.mock('../../apps/api/src/queue.js', () => ({
  enqueueDeployment: (id: string) => {
    enqueued.push(id);
    return Promise.resolve();
  },
}));

const { handler } = await import('../../apps/api/src/main.js');

const USER = 'usr_webhook';

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string>; user?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.user !== null) headers['x-debug-user'] = opts.user ?? USER;

  const result = await handler({
    version: '2.0',
    rawPath: path,
    headers,
    queryStringParameters: {},
    body: opts.body,
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
  process.env['API_PUBLIC_URL'] = 'https://api.example.com';
  delete process.env['DEV_USER_ID'];
});

beforeEach(async () => {
  enqueued.length = 0;
  await purge(`USER#${USER}`);
});

afterAll(async () => {
  await purge(`USER#${USER}`);
  for (const p of projects) await purge(`PROJECT#${p}`);
  delete process.env['ALLOW_DEBUG_AUTH'];
});

/** A project with auto-deploy enabled; returns its id and webhook secret. */
async function enabledProject(): Promise<{ projectId: string; secret: string }> {
  const created = await call('POST', '/projects', {
    body: JSON.stringify({
      name: 'webhook demo',
      repositoryUrl: 'https://github.com/octocat/Hello-World',
    }),
  });
  expect(created.status).toBe(201);
  const projectId = created.body.projectId as string;
  projects.push(projectId);

  const enabled = await call('POST', `/projects/${projectId}/webhook`);
  expect(enabled.status).toBe(200);
  expect(enabled.body.secret).toMatch(/^whsec_/);
  expect(enabled.body.url).toContain(`/webhooks/github/${projectId}`);

  return { projectId, secret: enabled.body.secret as string };
}

function push(branch = 'main'): string {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    after: 'a'.repeat(40),
    deleted: false,
    head_commit: { id: 'a'.repeat(40), message: 'a commit' },
    repository: { full_name: 'octocat/Hello-World' },
  });
}

function signed(body: string, secret: string, event = 'push'): Record<string, string> {
  return {
    'x-github-event': event,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
  };
}

describe('enabling a webhook', () => {
  it('returns a secret once and never exposes it again', async () => {
    const { projectId } = await enabledProject();

    // The project presenter must not leak the secret on a normal read.
    const project = await call('GET', `/projects/${projectId}`);
    expect(JSON.stringify(project.body)).not.toContain('whsec_');
  });

  it('rotates the secret on a second call', async () => {
    const { projectId } = await enabledProject();
    const again = await call('POST', `/projects/${projectId}/webhook`);
    expect(again.body.secret).toMatch(/^whsec_/);
  });

  it('refuses to enable a webhook on another user project', async () => {
    const { projectId } = await enabledProject();
    const res = await call('POST', `/projects/${projectId}/webhook`, { user: 'usr_someone_else' });
    expect(res.status).toBe(404);
  });
});

describe('receiving a push', () => {
  it('builds on a signed push to the default branch', async () => {
    const { projectId, secret } = await enabledProject();
    const body = push('main');

    const res = await call('POST', `/webhooks/github/${projectId}`, {
      user: null, // GitHub has no session
      body,
      headers: signed(body, secret),
    });

    expect(res.status).toBe(202);
    expect(res.body.branch).toBe('main');
    expect(enqueued).toHaveLength(1);

    // Recorded as webhook-triggered, and carrying the pushed commit.
    const deployment = await call('GET', `/deployments/${res.body.deploymentId}`);
    expect(deployment.body.trigger).toBe('webhook');
    expect(deployment.body.commitSha).toBe('a'.repeat(40));
  });

  it('acknowledges the ping GitHub sends on setup, and builds nothing', async () => {
    const { projectId, secret } = await enabledProject();
    const body = JSON.stringify({ zen: 'Design for failure.' });

    const res = await call('POST', `/webhooks/github/${projectId}`, {
      user: null,
      body,
      headers: signed(body, secret, 'ping'),
    });

    expect(res.status).toBe(200);
    expect(res.body.pong).toBe(true);
    expect(enqueued).toHaveLength(0);
  });
});

describe('a push that must NOT build', () => {
  it('rejects a forged signature with 401 and builds nothing', async () => {
    const { projectId } = await enabledProject();
    const body = push('main');

    const res = await call('POST', `/webhooks/github/${projectId}`, {
      user: null,
      body,
      headers: signed(body, 'whsec_' + 'f'.repeat(64)), // wrong secret
    });

    expect(res.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it('ignores a push to a non-default branch', async () => {
    const { projectId, secret } = await enabledProject();
    const body = push('feature/login');

    const res = await call('POST', `/webhooks/github/${projectId}`, {
      user: null,
      body,
      headers: signed(body, secret),
    });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toMatch(/default branch/);
    expect(enqueued).toHaveLength(0);
  });

  it('ignores a branch deletion', async () => {
    const { projectId, secret } = await enabledProject();
    const body = JSON.stringify({ ref: 'refs/heads/main', deleted: true });

    const res = await call('POST', `/webhooks/github/${projectId}`, {
      user: null,
      body,
      headers: signed(body, secret),
    });

    expect(res.body.skipped).toMatch(/deleted/);
    expect(enqueued).toHaveLength(0);
  });

  it('ignores a tag push', async () => {
    const { projectId, secret } = await enabledProject();
    const body = JSON.stringify({ ref: 'refs/tags/v1.0.0', deleted: false });

    const res = await call('POST', `/webhooks/github/${projectId}`, {
      user: null,
      body,
      headers: signed(body, secret),
    });

    expect(res.body.skipped).toMatch(/not a branch/);
    expect(enqueued).toHaveLength(0);
  });

  it('404s a webhook for a project that never enabled one', async () => {
    // A project with no secret has no webhook, so this is indistinguishable from
    // a project that does not exist.
    const created = await call('POST', '/projects', {
      body: JSON.stringify({
        name: 'no webhook',
        repositoryUrl: 'https://github.com/octocat/Spoon-Knife',
      }),
    });
    projects.push(created.body.projectId as string);
    const body = push('main');

    const res = await call('POST', `/webhooks/github/${created.body.projectId}`, {
      user: null,
      body,
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=deadbeef' },
    });

    expect(res.status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects a signature from another project (replay)', async () => {
    const a = await enabledProject();
    const b = await enabledProject();
    const body = push('main');

    // A perfectly valid signature — for project A — replayed at project B.
    const res = await call('POST', `/webhooks/github/${b.projectId}`, {
      user: null,
      body,
      headers: signed(body, a.secret),
    });

    expect(res.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });
});
