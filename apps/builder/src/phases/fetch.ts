/**
 * Phase 1 — fetch: get the source archive into the work directory.
 *
 * Local mode reads a file. AWS mode downloads from a presigned S3 URL — never
 * from GitHub. The container holds no GitHub credential and makes no request to
 * GitHub; the trusted control plane already did that (ADR-0004).
 *
 * The size cap is enforced WHILE streaming, not after. `Content-Length` is a
 * claim by the sender, so it is checked when present but never trusted alone: a
 * response that lies about its length still stops at the limit.
 */

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { BuildError, type BuilderConfig, type Logger } from '@platform/core';

export interface FetchResult {
  archivePath: string;
  archiveBytes: number;
}

export async function fetchSource(cfg: BuilderConfig, log: Logger): Promise<FetchResult> {
  await mkdir(cfg.workDir, { recursive: true });
  const archivePath = path.join(cfg.workDir, 'source.tar.gz');

  const archiveBytes =
    cfg.mode === 'local'
      ? await fetchFromDisk(cfg.sourcePath, archivePath, cfg.maxArchiveBytes)
      : await fetchFromUrl(cfg.sourceUrl, archivePath, cfg.maxArchiveBytes, log);

  log.info('source archive ready', { bytes: archiveBytes, path: archivePath });
  return { archivePath, archiveBytes };
}

async function fetchFromDisk(
  sourcePath: string,
  archivePath: string,
  maxBytes: number,
): Promise<number> {
  const source = path.resolve(sourcePath);

  let info;
  try {
    info = await stat(source);
  } catch {
    throw new BuildError('SOURCE_ERROR', `source archive not found: ${sourcePath}`);
  }
  if (!info.isFile()) {
    throw new BuildError('SOURCE_ERROR', `source path is not a file: ${sourcePath}`);
  }
  if (info.size > maxBytes) {
    throw new BuildError(
      'SOURCE_ERROR',
      `source archive is ${mb(info.size)} MB, over the ${mb(maxBytes)} MB limit`,
      { bytes: info.size, limit: maxBytes },
    );
  }

  await copyFile(source, archivePath);
  return info.size;
}

async function fetchFromUrl(
  url: string,
  archivePath: string,
  maxBytes: number,
  log: Logger,
): Promise<number> {
  log.info('downloading source archive');

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new BuildError(
      'SOURCE_ERROR',
      `could not download the source archive: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!response.ok) {
    // A 403 here is usually an expired presigned URL — worth saying so, because
    // "403" alone sends people looking at bucket policies.
    const hint = response.status === 403 ? ' (the presigned URL may have expired)' : '';
    throw new BuildError(
      'SOURCE_ERROR',
      `source archive download failed with HTTP ${response.status}${hint}`,
      { status: response.status },
    );
  }

  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BuildError(
      'SOURCE_ERROR',
      `source archive is ${mb(declared)} MB, over the ${mb(maxBytes)} MB limit`,
      { bytes: declared, limit: maxBytes },
    );
  }

  if (!response.body) {
    throw new BuildError('SOURCE_ERROR', 'source archive response had no body');
  }

  let received = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      if (received > maxBytes) {
        done(
          new BuildError('SOURCE_ERROR', `source archive exceeds the ${mb(maxBytes)} MB limit`, {
            limit: maxBytes,
          }),
        );
        return;
      }
      done(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body as never), capped, createWriteStream(archivePath));
  } catch (e) {
    // A partial file is worse than none: extraction would fail confusingly.
    await rm(archivePath, { force: true });
    if (e instanceof BuildError) throw e;
    throw new BuildError(
      'SOURCE_ERROR',
      `source archive download failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return received;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
