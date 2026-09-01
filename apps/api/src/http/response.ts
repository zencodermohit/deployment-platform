/**
 * API Gateway HTTP API (payload format 2.0) request and response helpers.
 */

import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ApiError, badRequest } from './errors.js';

export interface HttpRequest {
  method: string;
  path: string;
  pathParameters: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string | undefined;
  requestId: string;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Responses are per-user and must never be cached by anything in between.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

export function errorResponse(e: unknown, requestId: string): HttpResponse {
  if (e instanceof ApiError) {
    return json(e.status, { error: { code: e.code, message: e.message, requestId } });
  }

  if (e instanceof ZodError) {
    const first = e.errors[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return json(400, {
      error: { code: 'VALIDATION_FAILED', message: `${where}${first?.message ?? 'invalid request'}`, requestId },
    });
  }

  // Anything unexpected is a bug in this service. Log it, but never leak the
  // message: stack traces and driver errors are an information disclosure.
  console.error(JSON.stringify({ level: 'error', requestId, msg: String(e), stack: (e as Error)?.stack }));
  return json(500, {
    error: { code: 'INTERNAL', message: 'an unexpected error occurred', requestId },
  });
}

/** Parse and validate a JSON body. An absent body is treated as `{}`. */
export function parseBody<T extends ZodTypeAny>(req: HttpRequest, schema: T): z.infer<T> {
  const raw = req.rawBody?.trim();
  // The casts exist because Zod's `parse` is typed as `any` through a generic;
  // the runtime value genuinely is `z.infer<T>`.
  if (!raw) return schema.parse({}) as z.infer<T>;

  if (raw.length > 64 * 1024) {
    throw badRequest('request body is too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('request body is not valid JSON');
  }

  return schema.parse(parsed) as z.infer<T>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * First string-ish value, or the fallback.
 *
 * `String(a ?? b)` would happily stringify an object into "[object Object]" and
 * route on it — the event is attacker-reachable, so a non-string here should
 * fall back rather than become a nonsense method or path.
 */
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Normalise an API Gateway v2 event into something testable without AWS types. */
export function toHttpRequest(event: Record<string, unknown>): HttpRequest {
  // API Gateway's event is genuinely untyped at the edge of the system, so it
  // is narrowed here once rather than trusted throughout.
  const ctx = asRecord(event['requestContext']);
  const http = asRecord(ctx['http']);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(event['headers']))) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }

  let rawBody = event['body'] as string | undefined;
  if (rawBody && event['isBase64Encoded'] === true) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
  }

  return {
    method: asString(http['method'] ?? event['httpMethod'], 'GET').toUpperCase(),
    path: asString(http['path'] ?? event['rawPath'], '/'),
    pathParameters: (event['pathParameters'] ?? {}) as Record<string, string>,
    query: (event['queryStringParameters'] ?? {}) as Record<string, string>,
    headers,
    rawBody,
    requestId: asString(ctx['requestId'], 'local'),
  };
}
