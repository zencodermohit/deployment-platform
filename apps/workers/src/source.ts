/**
 * Source fetching, on the TRUSTED side of the boundary.
 *
 * This is the whole point of ADR-0004. If the build container cloned the
 * repository itself it would need a GitHub credential, and a malicious
 * `preinstall` would exfiltrate it before any build step ran — giving an
 * attacker read access to every repository that credential covers.
 *
 * Instead the control plane downloads the tarball here, puts it in S3, and
 * hands the container a presigned URL good for fifteen minutes and one object.
 *
 * M4 supports PUBLIC repositories only. GitHub's tarball endpoint needs no
 * authentication for those, so there is no token anywhere in the system yet.
 * Private repositories need a GitHub App installation token, which is the same
 * shape of call with an Authorization header — and requires manual setup.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});

export const PRESIGN_TTL_SEC = 900;

export interface FetchedSource {
  key: string;
  bytes: number;
  /** The resolved commit, so the build is pinned to something immutable. */
  commitSha: string | null;
}

export class SourceError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
  }
}

const USER_AGENT = 'deployment-platform/0.1';

/**
 * Resolve a branch to an immutable commit SHA.
 *
 * Done before the build so the deployment records exactly what was built. A
 * branch is a moving target; retrying "main" a day later builds different code
 * and the deployment record would quietly lie about what it contains.
 */
export async function resolveCommit(
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;

  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 404) {
    throw new SourceError(
      `repository or ref not found: ${owner}/${repo}@${ref} (private repositories are not supported yet)`,
      404,
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new SourceError('GitHub rate limit reached; try again shortly', response.status);
  }
  if (!response.ok) {
    throw new SourceError(`GitHub returned ${response.status} resolving ${ref}`, response.status);
  }

  const body = (await response.json()) as { sha?: string };
  return typeof body.sha === 'string' ? body.sha : null;
}

/**
 * Download the repository tarball and store it, enforcing the size cap while
 * streaming. The cap is checked here rather than in the container so an
 * oversized repository costs nothing — no task is ever started.
 */
export async function fetchSourceToS3(options: {
  owner: string;
  repo: string;
  ref: string;
  bucket: string;
  key: string;
  maxBytes: number;
}): Promise<FetchedSource> {
  const { owner, repo, ref, bucket, key, maxBytes } = options;

  const commitSha = await resolveCommit(owner, repo, ref);
  const tarballRef = commitSha ?? ref;

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(tarballRef)}`;

  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new SourceError(`could not download source: GitHub returned ${response.status}`, response.status);
  }

  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SourceError(
      `repository archive is ${(declared / 1024 / 1024).toFixed(1)} MB, over the ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit`,
    );
  }

  // Buffered rather than streamed: PutObject needs a known length, and the cap
  // is 100 MB, which fits comfortably in a Lambda with 512 MB of memory. If the
  // cap ever rises this becomes a multipart upload.
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxBytes) {
    throw new SourceError(
      `repository archive is ${(body.byteLength / 1024 / 1024).toFixed(1)} MB, over the limit`,
    );
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/gzip',
    }),
  );

  return { key, bytes: body.byteLength, commitSha };
}

/** A read URL for exactly one object, valid for fifteen minutes. */
export function presignSource(bucket: string, key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: PRESIGN_TTL_SEC,
  });
}
