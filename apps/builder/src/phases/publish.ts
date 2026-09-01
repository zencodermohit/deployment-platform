/**
 * Phase 6 — publish: write the artifacts to their destination.
 *
 * M1 copies to a local directory. M2 replaces the copy with S3 `PutObject` and
 * nothing else in this file changes: the concurrency limit, the per-file
 * Content-Type and Cache-Control, and the manifest are all already the shape the
 * S3 upload needs.
 *
 * Bounded concurrency (not one-at-a-time, not unbounded) is the same reason it
 * will matter against S3: serial uploads are pointlessly slow, and firing 20,000
 * at once exhausts sockets and gets you throttled.
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BuildError, type BuilderConfig, type Logger } from '@platform/core';
import type { ArtifactFile, CollectResult } from './collect.js';

export const UPLOAD_CONCURRENCY = 8;

export interface PublishResult {
  destination: string;
  manifestPath: string;
  fileCount: number;
  totalBytes: number;
}

export async function publishArtifacts(
  collected: CollectResult,
  cfg: BuilderConfig,
  log: Logger,
): Promise<PublishResult> {
  // The destination is derived from the deployment ID, never from anything the
  // repository can influence. Same rule as the S3 prefix in AWS (threat T4).
  const destination = path.join(path.resolve(cfg.outputDir), cfg.deploymentId);
  await mkdir(destination, { recursive: true });

  await mapWithConcurrency(collected.files, UPLOAD_CONCURRENCY, async (file) => {
    const target = path.join(destination, ...file.relPath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await copyFile(file.absPath, target);
    } catch (e) {
      throw new BuildError(
        'PUBLISH_FAILED',
        `failed to write ${file.relPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  // Written beside the artifact directory, not inside it, so it is never served.
  const manifestPath = `${destination}.manifest.json`;
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        deploymentId: cfg.deploymentId,
        createdAt: new Date().toISOString(),
        fileCount: collected.files.length,
        totalBytes: collected.totalBytes,
        files: collected.files.map((f) => ({
          path: f.relPath,
          bytes: f.bytes,
          contentType: f.contentType,
          cacheControl: f.cacheControl,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  log.info('artifacts published', {
    destination,
    fileCount: collected.files.length,
    totalBytes: collected.totalBytes,
  });

  return {
    destination,
    manifestPath,
    fileCount: collected.files.length,
    totalBytes: collected.totalBytes,
  };
}

/** Run `worker` over every item, with at most `limit` in flight at once. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export type { ArtifactFile };
