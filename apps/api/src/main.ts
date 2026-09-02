/**
 * The control-plane API. One Lambda, routing internally.
 *
 * Why one function rather than one per route: at this volume six functions
 * would each cold-start independently, each need their own role, log group and
 * integration, and all six would hold identical DynamoDB permissions anyway —
 * so splitting buys no isolation, only Terraform. Splitting later is mechanical
 * if a route ever needs different permissions or scaling. See ADR-0010.
 */

import { RepositoryUrlError } from './validation/schemas.js';
import { badRequest, conflict, notFound } from './http/errors.js';
import { errorResponse, json, toHttpRequest, type HttpRequest, type HttpResponse } from './http/response.js';
import { isConditionalCheckFailure } from '@platform/data';
import {
  handleCreateProject,
  handleGetProject,
  handleListProjects,
} from './handlers/projects.js';
import {
  handleCreateDeployment,
  handleGetDeployment,
  handleListDeployments,
} from './handlers/deployments.js';
import { handleStatusCallback } from './handlers/status.js';
import { handleCancel, handlePromote, handleRetry } from './handlers/actions.js';
import { handleEnableWebhook, handleWebhook } from './handlers/webhook.js';
import {
  handleLoginCallback,
  handleLoginStart,
  handleLogout,
  handleMe,
} from './handlers/auth.js';

type Handler = (req: HttpRequest) => Promise<HttpResponse>;

interface Route {
  method: string;
  /** Template with {name} placeholders, e.g. /projects/{projectId}/deployments */
  template: string;
  handler: Handler;
}

const ROUTES: Route[] = [
  { method: 'GET', template: '/health', handler: () => Promise.resolve(json(200, { ok: true })) },

  { method: 'GET', template: '/auth/github', handler: handleLoginStart },
  { method: 'GET', template: '/auth/github/callback', handler: handleLoginCallback },
  { method: 'POST', template: '/auth/logout', handler: handleLogout },
  { method: 'GET', template: '/me', handler: handleMe },

  { method: 'POST', template: '/projects', handler: handleCreateProject },
  { method: 'GET', template: '/projects', handler: handleListProjects },
  { method: 'GET', template: '/projects/{projectId}', handler: handleGetProject },

  { method: 'POST', template: '/projects/{projectId}/deployments', handler: handleCreateDeployment },
  { method: 'POST', template: '/projects/{projectId}/webhook', handler: handleEnableWebhook },
  { method: 'GET', template: '/projects/{projectId}/deployments', handler: handleListDeployments },

  { method: 'GET', template: '/deployments/{deploymentId}', handler: handleGetDeployment },
  { method: 'POST', template: '/deployments/{deploymentId}/promote', handler: handlePromote },
  { method: 'POST', template: '/deployments/{deploymentId}/retry', handler: handleRetry },
  { method: 'POST', template: '/deployments/{deploymentId}/cancel', handler: handleCancel },

  // Called by the build container, authenticated with a per-deployment token
  // rather than a session. Not part of the public surface.
  {
    method: 'POST',
    template: '/internal/deployments/{deploymentId}/status',
    handler: handleStatusCallback,
  },

  // Called by GitHub. No session; verified by HMAC signature (auth/webhook.ts).
  { method: 'POST', template: '/webhooks/github/{projectId}', handler: handleWebhook },
];

/** Match a concrete path against a template, extracting parameters. */
export function matchRoute(
  method: string,
  path: string,
): { handler: Handler; params: Record<string, string> } | null {
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);

  for (const route of ROUTES) {
    if (route.method !== method) continue;

    const template = route.template.split('/').filter(Boolean);
    if (template.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < template.length; i++) {
      const part = template[i]!;
      const value = segments[i]!;

      if (part.startsWith('{') && part.endsWith('}')) {
        params[part.slice(1, -1)] = decodeURIComponent(value);
      } else if (part !== value) {
        matched = false;
        break;
      }
    }

    if (matched) return { handler: route.handler, params };
  }

  return null;
}

export async function route(req: HttpRequest): Promise<HttpResponse> {
  const match = matchRoute(req.method, req.path);
  if (!match) throw notFound('route');

  // API Gateway supplies pathParameters, but matching them here too keeps the
  // handlers testable without an AWS event and independent of route config.
  return match.handler({ ...req, pathParameters: { ...req.pathParameters, ...match.params } });
}

export async function handler(event: Record<string, unknown>): Promise<HttpResponse> {
  const req = toHttpRequest(event);
  const started = Date.now();

  try {
    const response = await route(req);
    logRequest(req, response.statusCode, started);
    return response;
  } catch (e) {
    // Two repository-level failures have a natural HTTP meaning; everything
    // else falls through to the generic handler, which never leaks internals.
    const mapped =
      e instanceof RepositoryUrlError
        ? badRequest(e.message)
        : isConditionalCheckFailure(e)
          ? conflict('that resource already exists')
          : e;

    const response = errorResponse(mapped, req.requestId);
    logRequest(req, response.statusCode, started);
    return response;
  }
}

function logRequest(req: HttpRequest, status: number, started: number): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: status >= 500 ? 'error' : 'info',
      msg: 'request',
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status,
      durationMs: Date.now() - started,
    }),
  );
}
