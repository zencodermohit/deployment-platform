/**
 * Phase 5 — collect: find the build output and check it is publishable.
 *
 * A build can exit 0 and still have produced nothing useful. Catching that here
 * gives the user "your build produced no files" instead of a deployed blank
 * page, which is much harder to debug from the outside.
 *
 * Symlinks are rejected: object storage has no concept of them, so they would
 * silently vanish on upload and produce a site that works locally and not live.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  BuildError,
  cacheControlFor,
  contentTypeFor,
  type BuilderConfig,
  type Framework,
  type Logger,
} from '@platform/core';

export interface ArtifactFile {
  /** Path relative to the artifact root, always forward-slashed. */
  relPath: string;
  absPath: string;
  bytes: number;
  contentType: string;
  cacheControl: string;
}

export interface CollectResult {
  outputDir: string;
  files: ArtifactFile[];
  totalBytes: number;
}

export async function collectArtifacts(
  rootDir: string,
  framework: Framework,
  cfg: BuilderConfig,
  log: Logger,
): Promise<CollectResult> {
  const outputDir = path.resolve(rootDir, framework.outputDir);

  // The output directory is derived from our framework table, but resolve()
  // still gets verified: a table entry can only ever be inside the repo root.
  if (!isInside(rootDir, outputDir)) {
    throw new BuildError('INTERNAL', `output directory escapes the repository root: ${outputDir}`);
  }

  let info;
  try {
    info = await stat(outputDir);
  } catch {
    throw new BuildError(
      'NO_OUTPUT',
      `build finished but produced no "${framework.outputDir}" directory`,
      { expected: framework.outputDir },
    );
  }
  if (!info.isDirectory()) {
    throw new BuildError('NO_OUTPUT', `"${framework.outputDir}" exists but is not a directory`);
  }

  const files: ArtifactFile[] = [];
  let totalBytes = 0;

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        throw new BuildError(
          'NO_OUTPUT',
          `build output contains a symlink, which cannot be published: ${path.relative(outputDir, abs)}`,
        );
      }

      if (entry.isDirectory()) {
        // The static framework serves the repo root; skip what must not ship.
        if (framework.outputDir === '.' && SKIP_DIRS.has(entry.name)) continue;
        await walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;

      const fileInfo = await stat(abs);
      const relPath = path.relative(outputDir, abs).split(path.sep).join('/');

      files.push({
        relPath,
        absPath: abs,
        bytes: fileInfo.size,
        contentType: contentTypeFor(relPath),
        cacheControl: cacheControlFor(relPath),
      });
      totalBytes += fileInfo.size;

      if (files.length > cfg.maxArtifactFiles) {
        throw new BuildError(
          'ARTIFACT_TOO_LARGE',
          `build output has more than ${cfg.maxArtifactFiles} files`,
        );
      }
      if (totalBytes > cfg.maxArtifactBytes) {
        throw new BuildError(
          'ARTIFACT_TOO_LARGE',
          `build output exceeds ${mb(cfg.maxArtifactBytes)} MB`,
          { limit: cfg.maxArtifactBytes },
        );
      }
    }
  };

  await walk(outputDir);

  if (files.length === 0) {
    throw new BuildError('NO_OUTPUT', `"${framework.outputDir}" is empty`);
  }
  if (!files.some((f) => f.relPath === 'index.html')) {
    // A warning, not a failure: a site can legitimately have no root index.
    log.warn('no index.html at the artifact root; the deployment URL may 404');
  }

  log.info('artifacts collected', { fileCount: files.length, totalBytes, outputDir });
  return { outputDir, files, totalBytes };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '.next', '.cache']);

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
