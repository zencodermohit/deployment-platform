/**
 * Caller identity and the authorization rule.
 *
 * M3 has no real login yet — that arrives in M6. What matters is that the
 * *authorization* logic is real from the start: retrofitting ownership checks
 * onto handlers that assumed a single user is exactly how holes get left
 * behind. So identity is stubbed; the ownership check is not.
 *
 * When sessions land, only `identify()` changes.
 */

import { getProjectForUser } from '@platform/data';
import { notFound, unauthenticated } from './errors.js';
import type { HttpRequest } from './response.js';
import type { Project } from '@platform/core';

export interface Caller {
  userId: string;
}

/**
 * Resolve the caller.
 *
 * Fails CLOSED: with no dev user configured there is no caller, so a
 * misconfigured deployment returns 401 rather than silently treating everyone
 * as the same person.
 *
 * `X-Debug-User` is honoured only when ALLOW_DEBUG_AUTH is explicitly "true",
 * and exists so multi-user authorization can be exercised with curl before real
 * sessions exist. It must be off everywhere that matters.
 */
export function identify(req: HttpRequest): Caller {
  if (process.env['ALLOW_DEBUG_AUTH'] === 'true') {
    const override = req.headers['x-debug-user'];
    if (override && /^usr_[0-9a-z_-]{1,64}$/i.test(override)) {
      return { userId: override };
    }
  }

  const devUser = process.env['DEV_USER_ID'];
  if (devUser) return { userId: devUser };

  throw unauthenticated('no caller identity; real sessions arrive in M6');
}

/**
 * Load a project the caller owns, or 404.
 *
 * Uses a strongly consistent read scoped to the caller's own partition, so a
 * project belonging to someone else is not merely rejected — it is never read
 * at all. And the failure is 404, not 403, so the response cannot be used to
 * discover which project ids exist. Threat T11.
 */
export async function authorizeProject(caller: Caller, projectId: string): Promise<Project> {
  const project = await getProjectForUser(caller.userId, projectId);
  if (!project) throw notFound('project');
  return project;
}
