/**
 * Caller identity and the authorization rule.
 *
 * Authentication is a session token; authorization is an ownership check. They
 * were built in that order deliberately — the ownership check has been real
 * since M3, when identity was still stubbed, because retrofitting it onto
 * handlers that assumed a single user is how holes get left behind.
 */

import { getProjectForUser, getSession } from '@platform/data';
import { notFound, unauthenticated } from './errors.js';
import type { HttpRequest } from './response.js';
import type { Project } from '@platform/core';

export interface Caller {
  userId: string;
}

export function bearerToken(req: HttpRequest): string | null {
  const header = req.headers['authorization'];
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Resolve the caller, or refuse.
 *
 * Fails CLOSED at every branch: no token, an unknown token, an expired token
 * and a misconfigured service all produce 401 rather than a default identity.
 *
 * The DEV_USER_ID path is a development convenience and is only honoured when
 * AUTH_ENABLED is not "true". Once real auth is on, it is inert — so turning
 * authentication on cannot leave a bypass behind.
 */
export async function identify(req: HttpRequest): Promise<Caller> {
  const authEnabled = process.env['AUTH_ENABLED'] === 'true';

  if (authEnabled) {
    const token = bearerToken(req);
    if (!token) throw unauthenticated('a session token is required');

    const session = await getSession(token);
    if (!session) throw unauthenticated('this session is invalid or has expired');

    return { userId: session.userId };
  }

  // --- development only, unreachable once AUTH_ENABLED is true ---

  if (process.env['ALLOW_DEBUG_AUTH'] === 'true') {
    const override = req.headers['x-debug-user'];
    if (override && /^usr_[0-9a-z_-]{1,64}$/i.test(override)) {
      return { userId: override };
    }
  }

  const devUser = process.env['DEV_USER_ID'];
  if (devUser) return { userId: devUser };

  throw unauthenticated('authentication is not configured');
}

/**
 * Load a project the caller owns, or 404.
 *
 * Reads strongly consistently from the caller's OWN partition, so a project
 * belonging to someone else is not merely rejected — it is never read at all.
 * And the failure is 404, not 403, so the response cannot be used to discover
 * which project ids exist. Threat T11.
 */
export async function authorizeProject(caller: Caller, projectId: string): Promise<Project> {
  const project = await getProjectForUser(caller.userId, projectId);
  if (!project) throw notFound('project');
  return project;
}
