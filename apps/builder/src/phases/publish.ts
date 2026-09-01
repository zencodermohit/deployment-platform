/**
 * Phase 6 — publish: write the artifacts to their destination.
 *
 * Local mode copies to a directory; AWS mode uploads to S3. Everything else is
 * identical, because M1 was written with this swap in mind: the concurrency
 * limit, the per-file Content-Type and Cache-Control, and the manifest were all
 * already the shape the upload needed.
 *
 * Bounded concurrency matters more against S3 than it did on disk. Serial
 * uploads are pointlessly slow; firing twenty thousand at once exhausts sockets
 * and earns a throttle.
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BuildError, type AwsConfig, type BuilderConfig, type Logger } from '@platform/core';
import type { ArtifactFile, CollectResult } from './collect.js';

export const UPLOAD_CONCURRENCY = 8;

export interface PublishResult {
  destination: string;
  manifestPath: string | null;
  fileCount: number;
  totalBytes: number;
}

let s3: S3Client | undefined;
function client(): S3Client {
  // Credentials come from the ECS task role via the container metadata endpoint.
  // That role grants s3:PutObject on this deployment's prefix and nothing else.
  s3 ??= new S3Client({});
  return s3;
}

export async function publishArtifacts(
  collected: CollectResult,
  cfg: BuilderConfig,
  log: Logger,
): Promise<PublishResult> {
  return cfg.mode === 'local'
    ? publishToDisk(collected, cfg.outputDir, cfg.deploymentId, log)
    : publishToS3(collected, cfg, log);
}

async function publishToDisk(
  collected: CollectResult,
  outputDir: string,
  deploymentId: string,
  log: Logger,
): Promise<PublishResult> {
  // Derived from the deployment id, never from anything the repository can
  // influence — the same rule as the S3 prefix (threat T4).
  const destination = path.join(path.resolve(outputDir), deploymentId);
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
  await writeFile(manifestPath, manifestJson(collected, deploymentId), 'utf8');

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

async function publishToS3(
  collected: CollectResult,
  cfg: AwsConfig,
  log: Logger,
): Promise<PublishResult> {
  const destination = `s3://${cfg.artifactBucket}/${cfg.artifactPrefix}/`;
  let uploaded = 0;

  await mapWithConcurrency(collected.files, UPLOAD_CONCURRENCY, async (file) => {
    try {
      await client().send(
        new PutObjectCommand({
          Bucket: cfg.artifactBucket,
          Key: `${cfg.artifactPrefix}/${file.relPath}`,
          Body: createReadStream(file.absPath),
          ContentLength: file.bytes,
          ContentType: file.contentType,
          CacheControl: file.cacheControl,
        }),
      );
    } catch (e) {
      throw new BuildError(
        'PUBLISH_FAILED',
        `failed to upload ${file.relPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    uploaded += 1;
    // Progress on a long upload, without a line per file.
    if (uploaded % 100 === 0) {
      log.info('upload progress', { uploaded, total: collected.files.length });
    }
  });

  // The manifest goes one level up, outside the prefix the edge serves, so it
  // is never reachable as part of the site.
  const manifestKey = `${cfg.artifactPrefix}.manifest.json`;
  await client().send(
    new PutObjectCommand({
      Bucket: cfg.artifactBucket,
      Key: manifestKey,
      Body: manifestJson(collected, cfg.deploymentId),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'private, max-age=0, no-store',
    }),
  );

  log.info('artifacts published', {
    destination,
    fileCount: collected.files.length,
    totalBytes: collected.totalBytes,
  });

  return {
    destination,
    manifestPath: manifestKey,
    fileCount: collected.files.length,
    totalBytes: collected.totalBytes,
  };
}

function manifestJson(collected: CollectResult, deploymentId: string): string {
  return JSON.stringify(
    {
      deploymentId,
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
  );
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
