/**
 * Request validation.
 *
 * Zod is used here and deliberately not in @platform/core: core is bundled into
 * the container that runs untrusted code, and every dependency there is surface
 * area. Request bodies are attacker-controlled and genuinely complex, so they
 * get a real schema library. See packages/core/src/config.ts.
 *
 * The repository URL rules are the important part of this file — threats T12
 * (SSRF) and T15 (command injection) in docs/05-threat-model.md.
 */

import { z } from 'zod';

/** Only GitHub, and only this exact host. */
const ALLOWED_HOSTS = new Set(['github.com']);

export interface ParsedRepository {
  repositoryUrl: string;
  owner: string;
  repo: string;
}

export class RepositoryUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryUrlError';
  }
}

/**
 * Parse and validate a GitHub repository URL.
 *
 * Parsed with `new URL()`, never a regex. A regex over a URL is how
 * `https://github.com.evil.io/a/b` and `https://user:pass@github.com/a/b` get
 * through — both look right to a pattern and are not.
 */
export function parseRepositoryUrl(raw: unknown): ParsedRepository {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new RepositoryUrlError('repositoryUrl must be a non-empty string');
  }

  const value = raw.trim();
  if (value.length > 2048) {
    throw new RepositoryUrlError('repositoryUrl is too long');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryUrlError('repositoryUrl is not a valid URL');
  }

  if (url.protocol !== 'https:') {
    throw new RepositoryUrlError('repositoryUrl must use https');
  }

  // Exact match against an allowlist. A suffix check (`endsWith('github.com')`)
  // would accept `github.com.evil.io`.
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new RepositoryUrlError('only github.com repositories are supported');
  }

  // Credentials in the URL would be stored and later logged.
  if (url.username !== '' || url.password !== '') {
    throw new RepositoryUrlError('repositoryUrl must not contain credentials');
  }

  if (url.port !== '') {
    throw new RepositoryUrlError('repositoryUrl must not specify a port');
  }

  // A query or fragment is meaningless here and only widens the input surface.
  if (url.search !== '' || url.hash !== '') {
    throw new RepositoryUrlError('repositoryUrl must not contain a query or fragment');
  }

  const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match) {
    throw new RepositoryUrlError('repositoryUrl must be of the form https://github.com/owner/repo');
  }

  const [, owner, repo] = match as unknown as [string, string, string];

  for (const [label, segment] of [
    ['owner', owner],
    ['repository', repo],
  ] as const) {
    if (segment === '.' || segment === '..') {
      throw new RepositoryUrlError(`${label} name is not valid`);
    }
    if (segment.length > 100) {
      throw new RepositoryUrlError(`${label} name is too long`);
    }
  }

  return {
    // Stored normalised. Nothing downstream re-parses the raw string.
    repositoryUrl: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
  };
}

/**
 * Git ref names. Passed as a single argv element, never through a shell, so
 * this is defence in depth rather than the only thing standing between us and
 * `main; rm -rf /`.
 */
export const branchSchema = z
  .string()
  .min(1, 'branch must not be empty')
  .max(255, 'branch is too long')
  .regex(/^[\w./-]+$/, 'branch contains characters that are not valid in a git ref')
  .refine((b) => !b.includes('..'), 'branch must not contain ".."')
  .refine((b) => !b.startsWith('-'), 'branch must not start with "-"')
  .refine((b) => !b.startsWith('/') && !b.endsWith('/'), 'branch must not start or end with "/"')
  .refine((b) => !b.endsWith('.lock'), 'branch must not end with ".lock"');

export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'commitSha must be 40 lowercase hex characters');

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w:-]+$/, 'idempotencyKey may contain letters, numbers, _ - and :');

export const createDeploymentSchema = z.object({
  branch: branchSchema.optional(),
  commitSha: commitShaSchema.nullish(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

export const createProjectSchema = z.object({
  name: z
    .string()
    .min(1, 'name must not be empty')
    .max(100, 'name is too long')
    .regex(/^[\w][\w .-]*$/, 'name may contain letters, numbers, spaces, and . _ -'),
  // Validated by parseRepositoryUrl, which gives better errors than a regex.
  repositoryUrl: z.string().min(1),
  defaultBranch: branchSchema.default('main'),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(2048).optional(),
});

/** Status callback from the build container (ADR-0009). */
export const statusCallbackSchema = z.object({
  status: z.enum(['BUILDING', 'UPLOADING', 'DEPLOYED', 'FAILED']),
  phase: z.string().max(64).optional(),
  framework: z.string().max(64).nullish(),
  artifactBytes: z.number().int().nonnegative().nullish(),
  fileCount: z.number().int().nonnegative().nullish(),
  error: z
    .object({
      code: z.string().max(64),
      message: z.string().max(2048),
      exitCode: z.number().int().nullish(),
    })
    .nullish(),
});

export const promoteSchema = z.object({
  hostname: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'invalid hostname'),
});
