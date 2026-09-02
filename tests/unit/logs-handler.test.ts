/**
 * The logs handler: authorization, the CloudWatch filter it builds, pagination,
 * and defensive parsing.
 *
 * The CloudWatch client is mocked, so this asserts the REQUEST shape and the
 * response mapping — not that CloudWatch actually filters, which is its job.
 * The one thing a mock cannot catch here (that FilterLogEvents paginates with
 * empty pages) is exactly what bit the live endpoint, so the pagination-follow
 * is asserted explicitly below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { HttpRequest } from '../../apps/api/src/http/response.js';

const getDeploymentById = vi.fn();
vi.mock('@platform/data', () => ({ getDeploymentById: (id: string) => getDeploymentById(id) }));

const { handleGetLogs } = await import('../../apps/api/src/handlers/logs.js');

/** Handlers throw ApiError; main.ts catches and maps it. Mirror that here. */
async function status(promise: Promise<{ statusCode: number }>): Promise<number> {
  try {
    return (await promise).statusCode;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (typeof status === 'number') return status;
    throw e;
  }
}
const cwl = mockClient(CloudWatchLogsClient);

const OWNER = 'usr_owner';

function req(deploymentId: string, opts: { user?: string; since?: string } = {}): HttpRequest {
  return {
    method: 'GET',
    path: `/deployments/${deploymentId}/logs`,
    pathParameters: { deploymentId },
    query: opts.since ? { since: opts.since } : {},
    headers: { 'x-debug-user': opts.user ?? OWNER },
    rawBody: undefined,
    requestId: 'test',
  };
}

function ownedDeployment(overrides = {}) {
  return {
    deploymentId: 'dep_x',
    userId: OWNER,
    status: 'DEPLOYED',
    ...overrides,
  };
}

beforeEach(() => {
  cwl.reset();
  getDeploymentById.mockReset();
  process.env['ALLOW_DEBUG_AUTH'] = 'true';
  process.env['BUILD_LOG_GROUP'] = '/aws/ecs/test-builder';
  delete process.env['AUTH_ENABLED'];
  delete process.env['DEV_USER_ID'];
});

afterEach(() => {
  delete process.env['ALLOW_DEBUG_AUTH'];
});

describe('authorization', () => {
  it('404s a deployment that does not exist', async () => {
    getDeploymentById.mockResolvedValue(null);
    expect(await status(handleGetLogs(req('dep_missing')))).toBe(404);
  });

  it('404s another user deployment — same as missing, no oracle', async () => {
    getDeploymentById.mockResolvedValue(ownedDeployment({ userId: 'usr_someone_else' }));
    expect(await status(handleGetLogs(req('dep_x')))).toBe(404);
    // Never calls CloudWatch for a deployment the caller cannot see.
    expect(cwl.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });
});

describe('the CloudWatch query', () => {
  it('filters by the deploymentId field in the build log group', async () => {
    getDeploymentById.mockResolvedValue(ownedDeployment());
    cwl.on(FilterLogEventsCommand).resolves({ events: [] });

    await handleGetLogs(req('dep_x'));

    const input = cwl.commandCalls(FilterLogEventsCommand)[0]!.args[0].input;
    expect(input.logGroupName).toBe('/aws/ecs/test-builder');
    expect(input.filterPattern).toBe('{ $.deploymentId = "dep_x" }');
    expect(input.startTime).toBeUndefined();
  });

  it('passes since through as startTime', async () => {
    getDeploymentById.mockResolvedValue(ownedDeployment());
    cwl.on(FilterLogEventsCommand).resolves({ events: [] });

    await handleGetLogs(req('dep_x', { since: '1788000000000' }));

    expect(cwl.commandCalls(FilterLogEventsCommand)[0]!.args[0].input.startTime).toBe(1788000000000);
  });

  it('rejects a non-numeric since', async () => {
    getDeploymentById.mockResolvedValue(ownedDeployment());
    expect(await status(handleGetLogs(req('dep_x', { since: 'yesterday' })))).toBe(400);
  });

  it('FOLLOWS pagination — empty first page with a token is not the end', async () => {
    getDeploymentById.mockResolvedValue(ownedDeployment());
    // This is the exact live bug reproduced: the first page has no events but a
    // token, the second has the real lines. A single-call handler returns zero.
    cwl
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [], nextToken: 'page2' })
      .resolvesOnce({
        events: [
          { message: JSON.stringify({ ts: '2026-09-02T00:00:00Z', level: 'info', phase: 'build', msg: 'built' }), timestamp: 1788000000000 },
        ],
      });

    const res = await handleGetLogs(req('dep_x'));
    const body = JSON.parse(res.body);

    expect(cwl.commandCalls(FilterLogEventsCommand)).toHaveLength(2);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].msg).toBe('built');
    expect(body.nextSince).toBe(1788000000001); // maxTs + 1
  });
});

describe('response mapping', () => {
  it('reports complete for a terminal deployment and incomplete for a live one', async () => {
    cwl.on(FilterLogEventsCommand).resolves({ events: [] });

    getDeploymentById.mockResolvedValue(ownedDeployment({ status: 'DEPLOYED' }));
    expect(JSON.parse((await handleGetLogs(req('dep_x'))).body).complete).toBe(true);

    getDeploymentById.mockResolvedValue(ownedDeployment({ status: 'BUILDING' }));
    expect(JSON.parse((await handleGetLogs(req('dep_x'))).body).complete).toBe(false);
  });

  it('shows a non-JSON line verbatim instead of throwing', async () => {
    getDeploymentById.mockResolvedValue(ownedDeployment());
    cwl.on(FilterLogEventsCommand).resolves({
      events: [{ message: 'a raw non-json crash line', timestamp: 1788000000000 }],
    });

    const line = JSON.parse((await handleGetLogs(req('dep_x'))).body).lines[0];
    expect(line.msg).toBe('a raw non-json crash line');
    expect(line.level).toBe('info');
  });
});
