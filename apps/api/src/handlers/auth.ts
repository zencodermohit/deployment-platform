/**
 * Login, logout, and "who am I".
 *
 * The flow:
 *   GET /auth/github          -> 302 to GitHub, carrying a signed state
 *   GET /auth/github/callback -> exchange the code, upsert the user, issue a
 *                                session token
 *   GET  /me                  -> the current user
 *   POST /auth/logout         -> revoke this session
 */

import { generateSessionId, generateUserId } from '@platform/core';
import {
  createSession,
  deleteSession,
  getUser,
  getUserByGithubId,
  putUser,
  SESSION_TTL_SEC,
} from '@platform/data';
import { authorizeUrl, createState, exchangeCode, verifyState } from '../auth/github.js';
import { badRequest, notFound } from '../http/errors.js';
import { bearerToken, identify } from '../http/auth.js';
import { json, type HttpRequest, type HttpResponse } from '../http/response.js';

function redirectUri(): string {
  const base = process.env['API_PUBLIC_URL'];
  if (!base) throw badRequest('API_PUBLIC_URL is not configured');
  return `${base}/auth/github/callback`;
}

export async function handleLoginStart(_req: HttpRequest): Promise<HttpResponse> {
  const state = await createState();
  const location = await authorizeUrl(state, redirectUri());

  return {
    statusCode: 302,
    headers: { location, 'cache-control': 'no-store' },
    body: '',
  };
}

export async function handleLoginCallback(req: HttpRequest): Promise<HttpResponse> {
  // GitHub reports user-facing refusals here rather than as an HTTP error.
  if (req.query['error']) {
    throw badRequest(`GitHub declined the login: ${req.query['error_description'] ?? req.query['error']}`);
  }

  const code = req.query['code'];
  const state = req.query['state'];
  if (!code || !state) throw badRequest('missing code or state');

  // Before the exchange: an unverified state means this request may not have
  // started with us at all.
  await verifyState(state);

  const profile = await exchangeCode(code, redirectUri());

  // Matched on GitHub's numeric id, never the login — usernames can be changed
  // and then claimed by somebody else.
  const existing = await getUserByGithubId(profile.githubId);
  const now = new Date().toISOString();

  const user = await putUser({
    userId: existing?.userId ?? generateUserId(),
    githubId: profile.githubId,
    login: profile.login,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    createdAt: existing?.createdAt ?? now,
    lastLoginAt: now,
  });

  const token = generateSessionId();
  const session = await createSession(user.userId, token);

  const dashboard = process.env['DASHBOARD_URL'];
  if (dashboard) {
    // Fragment, not query string: fragments are not sent to servers and do not
    // land in access logs or Referer headers.
    return {
      statusCode: 302,
      headers: {
        location: `${dashboard}/#session=${encodeURIComponent(token)}`,
        'cache-control': 'no-store',
      },
      body: '',
    };
  }

  return json(200, {
    sessionToken: token,
    expiresAt: session.expiresAt,
    expiresInSeconds: SESSION_TTL_SEC,
    user: { userId: user.userId, login: user.login, avatarUrl: user.avatarUrl },
  });
}

export async function handleMe(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const user = await getUser(caller.userId);

  if (!user) {
    // With authentication off, identify() resolves to DEV_USER_ID, for which no
    // user record exists — nobody has ever logged in. Returning a stand-in lets
    // the dashboard be used before the OAuth app exists.
    //
    // Strictly gated: once AUTH_ENABLED is true, identify() has already required
    // a real session, so reaching here means a session pointing at a deleted
    // user, which genuinely is a 404.
    if (process.env['AUTH_ENABLED'] !== 'true') {
      return json(200, {
        userId: caller.userId,
        login: 'dev',
        email: null,
        avatarUrl: null,
        createdAt: null,
        authDisabled: true,
      });
    }
    throw notFound('user');
  }

  return json(200, {
    userId: user.userId,
    login: user.login,
    email: user.email,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  });
}

export async function handleLogout(req: HttpRequest): Promise<HttpResponse> {
  const token = bearerToken(req);
  // Idempotent: logging out twice, or with a token that has already expired, is
  // a success rather than an error.
  if (token) await deleteSession(token);
  return json(200, { ok: true });
}
