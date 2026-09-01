/**
 * Phase 1 — fetch: get the source archive into the work directory.
 *
 * M1 reads a local file. In M4 this becomes an HTTPS GET against a presigned S3
 * URL, and everything downstream is unchanged — which is the point of making
 * fetch its own phase rather than inlining it.
 */

import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { BuildError, type BuilderConfig, type Logger } from '@platform/core';

export interface FetchResult {
  archivePath: string;
  archiveBytes: number;
}

export async function fetchSource(cfg: BuilderConfig, log: Logger): Promise<FetchResult> {
  const source = path.resolve(cfg.sourcePath);

  let info;
  try {
    info = await stat(source);
  } catch {
    throw new BuildError('SOURCE_ERROR', `source archive not found: ${cfg.sourcePath}`);
  }

  if (!info.isFile()) {
    throw new BuildError('SOURCE_ERROR', `source path is not a file: ${cfg.sourcePath}`);
  }

  // Checked before anything is extracted, so an oversized archive costs nothing.
  if (info.size > cfg.maxArchiveBytes) {
    throw new BuildError(
      'SOURCE_ERROR',
      `source archive is ${mb(info.size)} MB, over the ${mb(cfg.maxArchiveBytes)} MB limit`,
      { bytes: info.size, limit: cfg.maxArchiveBytes },
    );
  }

  await mkdir(cfg.workDir, { recursive: true });
  const archivePath = path.join(cfg.workDir, 'source.tar.gz');
  await copyFile(source, archivePath);

  log.info('source archive ready', { bytes: info.size, path: archivePath });
  return { archivePath, archiveBytes: info.size };
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
