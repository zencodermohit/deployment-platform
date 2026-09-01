/**
 * The API exercised end to end against real DynamoDB, without Lambda or API
 * Gateway in the way.
 *
 * This is the localhost-first loop for M3: real handlers, real validation, real
 * database, real conditional writes — everything except the two AWS services
 * that only transport the request. Deploying adds transport; it does not add
 * behaviour, so behaviour is proved here where the feedback is seconds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../../apps/api/src/main.js';
import { documentClient, tableName } from '@platform/data';

const USER_A = 'usr_alice';
const USER_B = 'usr_bob';

interface Response {
  status: number;
  /**
   * Deliberately `any`. These tests assert on arbitrary JSON shapes from a dozen
   * endpoints; typing each one would duplicate the handlers' own types and make
   * the tests agree with the code by construction rather than by checking it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; user?: string | null; query?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.user !== null) headers['x-debug-user'] = options.user ?? USER_A;

  const result = await handler({
    version: '2.0',
    rawPath: path,
    headers,
    queryStringParameters: options.query ?? {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: { requestId: 'test-request', http: { method, path } },
  });

  return { status: result.statusCode, body: JSON.parse(result.body) };
}

async function purgeUser(userId: string): Promise<void> {
  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}` },
      // Cleanup must see everything the previous test wrote, or the next test
      // inherits its projects and trips the per-user quota.
      ConsistentRead: true,
    }),
  );
  for (const item of result.Items ?? []) {
    await documentClient().send(
      new DeleteCommand({ TableName: tableName(), Key: { PK: item['PK'], SK: item['SK'] } }),
    );
  }
}

const createdProjects: string[] = [];

beforeAll(() => {
  expect(tableName()).toMatch(/-test$/);
  process.env['ALLOW_DEBUG_AUTH'] = 'true';
  process.env['CLOUDFRONT_DOMAIN'] = 'd3895jyfnxjrwh.cloudfront.net';
  delete process.env['DEV_USER_ID'];
});

/**
 * Tests share two user ids, and a user may hold at most ten projects. Without
 * this, the suite exhausts its own quota partway through and later tests fail
 * for a reason that has nothing to do with what they are testing — which is
 * exactly what happened the first time this file ran.
 */
beforeEach(async () => {
  await purgeUser(USER_A);
  await purgeUser(USER_B);
});

afterAll(async () => {
  await purgeUser(USER_A);
  await purgeUser(USER_B);
  for (const projectId of createdProjects) {
    const result = await documentClient().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `PROJECT#${projectId}` },
      }),
    );
    for (const item of result.Items ?? []) {
      await documentClient().send(
        new DeleteCommand({ TableName: tableName(), Key: { PK: item['PK'], SK: item['SK'] } }),
      );
    }
  }
  delete process.env['ALLOW_DEBUG_AUTH'];
});

async function newProject(user = USER_A, name = 'my blog'): Promise<string> {
  const res = await call('POST', '/projects', {
    user,
    body: { name, repositoryUrl: 'https://github.com/octocat/hello-world' },
  });
  expect(res.status).toBe(201);
  createdProjects.push(res.body['projectId']);
  return res.body['projectId'];
}

describe('routing', () => {
  it('answers a health check without authentication', async () => {
    const res = await call('GET', '/health', { user: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('404s an unknown route', async () => {
    const res = await call('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.body['error']['code']).toBe('NOT_FOUND');
  });

  it('404s a known path with the wrong method', async () => {
    expect((await call('DELETE', '/projects')).status).toBe(404);
  });

  it('includes the request id in every error', async () => {
    const res = await call('GET', '/nope');
    expect(res.body['error']['requestId']).toBe('test-request');
  });
});

describe('authentication', () => {
  it('401s when there is no caller at all', async () => {
    const res = await call('GET', '/projects', { user: null });
    expect(res.status).toBe(401);
    expect(res.body['error']['code']).toBe('UNAUTHENTICATED');
  });

  it('fails closed: an unrecognised debug user is not trusted', async () => {
    const res = await call('GET', '/projects', { user: 'not a user id' });
    expect(res.status).toBe(401);
  });
});

describe('projects', () => {
  it('creates a project and normalises the repository url', async () => {
    const res = await call('POST', '/projects', {
      body: { name: 'my blog', repositoryUrl: 'https://github.com/Octocat/Hello-World.git/' },
    });
    expect(res.status).toBe(201);
    createdProjects.push(res.body['projectId']);

    expect(res.body['projectId']).toMatch(/^prj_[0-9a-f]{32}$/);
    expect(res.body['repositoryUrl']).toBe('https://github.com/Octocat/Hello-World');
    expect(res.body['defaultBranch']).toBe('main');
    expect(res.body['activeDeploymentId']).toBeNull();
  });

  it('rejects a repository url that is not github', async () => {
    const res = await call('POST', '/projects', {
      body: { name: 'evil', repositoryUrl: 'https://github.com.evil.io/a/b' },
    });
    expect(res.status).toBe(400);
    expect(res.body['error']['code']).toBe('VALIDATION_FAILED');
    expect(res.body['error']['message']).toMatch(/github\.com/);
  });

  it('rejects an SSRF attempt at instance metadata', async () => {
    const res = await call('POST', '/projects', {
      body: { name: 'ssrf', repositoryUrl: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed body with a specific message', async () => {
    const res = await call('POST', '/projects', { body: { name: '' } });
    expect(res.status).toBe(400);
    expect(res.body['error']['message']).toMatch(/name/);
  });

  it('lists only the calling user projects', async () => {
    await newProject(USER_A, 'alice one');
    await newProject(USER_B, 'bob one');

    const alice = await call('GET', '/projects', { user: USER_A });
    const names = alice.body['projects'].map((p: { name: string }) => p.name);

    expect(names).toContain('alice one');
    expect(names).not.toContain('bob one');
  });

  it('reads back a project it owns', async () => {
    const projectId = await newProject();
    const res = await call('GET', `/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body['projectId']).toBe(projectId);
  });
});

describe('authorization — threat T11', () => {
  it('returns 404, not 403, for another user project', async () => {
    const bobProject = await newProject(USER_B, 'bob private');

    const res = await call('GET', `/projects/${bobProject}`, { user: USER_A });

    // 404 and not 403: a 403 would confirm the id exists, turning the endpoint
    // into an enumeration oracle.
    expect(res.status).toBe(404);
    expect(res.body['error']['code']).toBe('NOT_FOUND');
  });

  it('is indistinguishable from a project that never existed', async () => {
    const bobProject = await newProject(USER_B, 'bob private 2');

    const foreign = await call('GET', `/projects/${bobProject}`, { user: USER_A });
    const absent = await call('GET', '/projects/prj_00000000000000000000000000000000', {
      user: USER_A,
    });

    expect(foreign.status).toBe(absent.status);
    expect(foreign.body['error']['code']).toBe(absent.body['error']['code']);
    expect(foreign.body['error']['message']).toBe(absent.body['error']['message']);
  });

  it('refuses to deploy another user project', async () => {
    const bobProject = await newProject(USER_B, 'bob deployable');
    const res = await call('POST', `/projects/${bobProject}/deployments`, { user: USER_A });
    expect(res.status).toBe(404);
  });

  it('refuses to list another user deployments', async () => {
    const bobProject = await newProject(USER_B, 'bob listable');
    const res = await call('GET', `/projects/${bobProject}/deployments`, { user: USER_A });
    expect(res.status).toBe(404);
  });
});

describe('deployments', () => {
  it('accepts a deployment with 202 and queues it', async () => {
    const projectId = await newProject();
    const res = await call('POST', `/projects/${projectId}/deployments`);

    // 202, not 201: the record exists, the work has not happened.
    expect(res.status).toBe(202);
    expect(res.body['deploymentId']).toMatch(/^dep_[0-9a-f]{32}$/);
    expect(res.body['status']).toBe('QUEUED');
    expect(res.body['branch']).toBe('main');
    expect(res.body['url']).toMatch(/^https:\/\/.+\/d\/dep_[0-9a-f]{32}\/$/);
  });

  it('uses the branch given, when it is valid', async () => {
    const projectId = await newProject();
    const res = await call('POST', `/projects/${projectId}/deployments`, {
      body: { branch: 'feature/login' },
    });
    expect(res.body['branch']).toBe('feature/login');
  });

  it('rejects a branch containing shell metacharacters', async () => {
    const projectId = await newProject();
    const res = await call('POST', `/projects/${projectId}/deployments`, {
      body: { branch: 'main; rm -rf /' },
    });
    expect(res.status).toBe(400);
    expect(res.body['error']['message']).toMatch(/branch/);
  });

  it('never exposes internal plumbing', async () => {
    const projectId = await newProject();
    const res = await call('POST', `/projects/${projectId}/deployments`);

    for (const secret of ['artifactPrefix', 'taskArn', 'statusTokenHash', 'deadlineAt', 'PK', 'SK']) {
      expect(Object.keys(res.body), secret).not.toContain(secret);
    }
  });

  it('ignores a repositoryUrl smuggled into the deployment body', async () => {
    const projectId = await newProject();
    await call('POST', `/projects/${projectId}/deployments`, {
      body: { repositoryUrl: 'https://github.com/attacker/evil' },
    });

    // The project's repository is what counts, and it is unchanged.
    const project = await call('GET', `/projects/${projectId}`);
    expect(project.body['repositoryUrl']).toBe('https://github.com/octocat/hello-world');
  });

  it('reads a deployment back by id alone', async () => {
    const projectId = await newProject();
    const created = await call('POST', `/projects/${projectId}/deployments`);
    const deploymentId = created.body['deploymentId'];

    let res = await call('GET', `/deployments/${deploymentId}`);
    for (let attempt = 0; attempt < 20 && res.status === 404; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      res = await call('GET', `/deployments/${deploymentId}`);
    }

    expect(res.status).toBe(200);
    expect(res.body['deploymentId']).toBe(deploymentId);
  });

  it('hides another user deployment behind the same 404', async () => {
    const bobProject = await newProject(USER_B, 'bob deploys');
    const created = await call('POST', `/projects/${bobProject}/deployments`, { user: USER_B });
    const deploymentId = created.body['deploymentId'];

    // Give the index a moment, then confirm Alice still cannot read it.
    await new Promise((r) => setTimeout(r, 2000));

    const asBob = await call('GET', `/deployments/${deploymentId}`, { user: USER_B });
    const asAlice = await call('GET', `/deployments/${deploymentId}`, { user: USER_A });

    expect(asBob.status).toBe(200);
    expect(asAlice.status).toBe(404);
  });

  it('lists a project deployments newest first', async () => {
    const projectId = await newProject();
    const first = await call('POST', `/projects/${projectId}/deployments`);
    await new Promise((r) => setTimeout(r, 1100));
    const second = await call('POST', `/projects/${projectId}/deployments`);

    const res = await call('GET', `/projects/${projectId}/deployments`);
    const ids = res.body['deployments'].map((d: { deploymentId: string }) => d.deploymentId);

    expect(ids[0]).toBe(second.body['deploymentId']);
    expect(ids[1]).toBe(first.body['deploymentId']);
  });

  it('rejects an out-of-range page size', async () => {
    const projectId = await newProject();
    const res = await call('GET', `/projects/${projectId}/deployments`, {
      query: { limit: '9999' },
    });
    expect(res.status).toBe(400);
  });

  it('accepts a page size at the limit', async () => {
    const projectId = await newProject();
    const res = await call('GET', `/projects/${projectId}/deployments`, {
      query: { limit: '100' },
    });
    expect(res.status).toBe(200);
  });
});

describe('quotas', () => {
  it('refuses an eleventh project with 429', async () => {
    for (let i = 0; i < 10; i++) {
      await newProject(USER_A, `project ${i}`);
    }

    const res = await call('POST', '/projects', {
      user: USER_A,
      body: { name: 'one too many', repositoryUrl: 'https://github.com/octocat/hello-world' },
    });

    expect(res.status).toBe(429);
    expect(res.body['error']['code']).toBe('QUOTA_EXCEEDED');
  });
});
