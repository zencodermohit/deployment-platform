/**
 * GitHub OAuth.
 *
 * The `state` parameter is HMAC-signed and timestamped rather than stored
 * server-side. Without it, an attacker can complete a login flow in a victim's
 * browser using their own code — login CSRF, which quietly logs the victim into
 * the attacker's account and hands over anything they then create.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ApiError, badRequest } from '../http/errors.js';

const STATE_TTL_MS = 10 * 60 * 1000;

let cached: { clientId: string; clientSecret: string; stateSecret: string } | undefined;
const ssm = new SSMClient({});

/**
 * Read OAuth credentials from Parameter Store once per cold start.
 *
 * SSM SecureString rather than Secrets Manager: encrypted with the same
 * customer-managed key, and free at this scale where Secrets Manager is
 * $0.40/secret/month (docs/06-cost-model.md).
 */
async function credentials(): Promise<{ clientId: string; clientSecret: string; stateSecret: string }> {
  if (cached) return cached;

  const prefix = process.env['SSM_PREFIX'] ?? '/deployment-platform';
  const names = [`${prefix}/github/client_id`, `${prefix}/github/client_secret`, `${prefix}/session/state_secret`];

  const values = await Promise.all(
    names.map(async (name) => {
      const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return result.Parameter?.Value ?? '';
    }),
  );

  const [clientId, clientSecret, stateSecret] = values as [string, string, string];

  // Terraform creates these parameters with a placeholder so the IAM policy can
  // reference them; the real values are written out of band. Treating the
  // placeholder as configured would redirect users to GitHub with a nonsense
  // client id and produce a baffling error there rather than a clear one here.
  const missing = [clientId, clientSecret, stateSecret].some(
    (value) => !value || value === 'PLACEHOLDER',
  );
  if (missing) {
    throw new ApiError(
      'INTERNAL',
      'GitHub OAuth is not configured; set the client id and secret in Parameter Store',
    );
  }

  cached = { clientId, clientSecret, stateSecret };
  return cached;
}

export function isConfigured(): boolean {
  return process.env['AUTH_ENABLED'] === 'true';
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export async function createState(): Promise<string> {
  const { stateSecret } = await credentials();
  const payload = `${Date.now()}.${randomBytes(16).toString('hex')}`;
  return `${payload}.${sign(payload, stateSecret)}`;
}

export async function verifyState(state: string): Promise<void> {
  const { stateSecret } = await credentials();

  const parts = state.split('.');
  if (parts.length !== 3) throw badRequest('invalid state');

  const [issuedAt, nonce, presented] = parts as [string, string, string];
  const expected = sign(`${issuedAt}.${nonce}`, stateSecret);

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw badRequest('invalid state');

  // Bound the window so a captured state cannot be replayed indefinitely.
  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) {
    throw badRequest('the login attempt expired; start again');
  }
}

/* ------------------------------------------------------------------ *
 * Flow
 * ------------------------------------------------------------------ */

export async function authorizeUrl(state: string, redirectUri: string): Promise<string> {
  const { clientId } = await credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    // No scopes. We only need the account identity; asking for repo access we
    // do not use would be a much bigger thing to ask of a user.
    scope: 'read:user',
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export interface GithubUser {
  githubId: string;
  login: string;
  email: string | null;
  avatarUrl: string | null;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<GithubUser> {
  const { clientId, clientSecret } = await credentials();

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!tokenResponse.ok) throw badRequest('GitHub rejected the login attempt');

  const token = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!token.access_token) {
    throw badRequest(`GitHub rejected the login attempt: ${token.error ?? 'no token returned'}`);
  }

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'deployment-platform/0.1',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!userResponse.ok) throw badRequest('could not read the GitHub profile');

  const profile = (await userResponse.json()) as {
    id?: number;
    login?: string;
    email?: string | null;
    avatar_url?: string | null;
  };

  if (!profile.id || !profile.login) throw badRequest('GitHub returned an unusable profile');

  // The access token is deliberately NOT stored. It is used once, here, to read
  // the account identity, and then discarded — keeping a token we have no use
  // for would be a liability with no upside.
  return {
    githubId: String(profile.id),
    login: profile.login,
    email: profile.email ?? null,
    avatarUrl: profile.avatar_url ?? null,
  };
}
