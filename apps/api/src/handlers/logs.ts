/**
 * GET /deployments/{deploymentId}/logs
 *
 * Specified in docs/03-api.md and never built. The build container writes one
 * structured JSON line per event to CloudWatch; this reads them back for the
 * one deployment the caller owns.
 *
 * Logs are keyed by a FILTER on the `deploymentId` field, not by log stream:
 * the awslogs driver names streams after the ECS task, which the API cannot
 * know, whereas every line the builder writes carries its deployment id. So the
 * query is "every event in the build log group where deploymentId = this one",
 * which CloudWatch answers directly.
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { isTerminal } from '@platform/core';
import { getDeploymentById } from '@platform/data';
import { identify } from '../http/auth.js';
import { badRequest, notFound } from '../http/errors.js';
import { json, type HttpRequest, type HttpResponse } from '../http/response.js';

let client: CloudWatchLogsClient | undefined;
function logs(): CloudWatchLogsClient {
  client ??= new CloudWatchLogsClient({});
  return client;
}

interface LogLine {
  ts: string;
  level: string;
  phase: string;
  msg: string;
}

export async function handleGetLogs(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const deploymentId = req.pathParameters['deploymentId'];
  if (!deploymentId) throw notFound('deployment');

  const deployment = await getDeploymentById(deploymentId);
  // Same 404 for absent and not-yours — the logs endpoint must not become a way
  // to confirm which deployment ids exist.
  if (!deployment || deployment.userId !== caller.userId) throw notFound('deployment');

  const since = parseSince(req.query['since']);
  const logGroup = process.env['BUILD_LOG_GROUP'] ?? '/aws/ecs/deployment-platform-builder';

  const lines: LogLine[] = [];
  let maxTs = since ?? 0;

  // FilterLogEvents returns results INCREMENTALLY: an empty `events` array with
  // a `nextToken` means "scanned a chunk, nothing matched yet, keep going" — not
  // "done". Reading only the first page is why this first returned zero lines
  // for a deployment whose logs plainly existed. Follow the token, with a page
  // cap so a huge log group cannot make one request run forever.
  let token: string | undefined;
  const MAX_PAGES = 20;
  const MAX_LINES = 2000;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await logs().send(
      new FilterLogEventsCommand({
        logGroupName: logGroup,
        // A JSON metric-filter pattern: match events whose deploymentId field is
        // this deployment. The `logStreamName` on the record is not used — see
        // the file header for why.
        filterPattern: `{ $.deploymentId = "${deploymentId}" }`,
        ...(since !== undefined ? { startTime: since } : {}),
        ...(token ? { nextToken: token } : {}),
      }),
    );

    for (const event of result.events ?? []) {
      if (typeof event.timestamp === 'number' && event.timestamp > maxTs) maxTs = event.timestamp;
      lines.push(parseLine(event.message ?? '', event.timestamp));
    }

    token = result.nextToken;
    if (!token || lines.length >= MAX_LINES) break;
  }

  return json(200, {
    lines,
    // Where to resume polling from. +1 so the same last event is not re-fetched.
    nextSince: maxTs > 0 ? maxTs + 1 : since ?? null,
    // A terminal deployment writes no more logs, so the client can stop polling.
    complete: isTerminal(deployment.status),
  });
}

/**
 * Every builder line is JSON, but never assume it: a crash or a stray write
 * could produce a raw line, and a logs viewer that throws on one bad line is
 * worse than one that shows it verbatim.
 */
function parseLine(message: string, timestamp: number | undefined): LogLine {
  const fallbackTs = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
  try {
    const parsed = JSON.parse(message) as Partial<LogLine>;
    return {
      ts: typeof parsed.ts === 'string' ? parsed.ts : fallbackTs,
      level: typeof parsed.level === 'string' ? parsed.level : 'info',
      phase: typeof parsed.phase === 'string' ? parsed.phase : '',
      msg: typeof parsed.msg === 'string' ? parsed.msg : message,
    };
  } catch {
    return { ts: fallbackTs, level: 'info', phase: '', msg: message.trimEnd() };
  }
}

function parseSince(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  // Milliseconds since the epoch, as this endpoint's own nextSince hands back.
  if (!Number.isInteger(n) || n < 0 || n > 4_102_444_800_000) {
    throw badRequest('since must be a millisecond epoch timestamp');
  }
  return n;
}
