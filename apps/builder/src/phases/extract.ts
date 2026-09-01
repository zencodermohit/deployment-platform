/**
 * Phase 1b — extract: unpack the archive, treating every entry as hostile.
 *
 * This is the most security-sensitive file in the builder. A tar archive can
 * carry entries that write outside the directory you extract into ("zip slip"),
 * symlinks that point at /etc, and 1 MB of gzip that expands to 100 GB.
 * Threat T7 in docs/05-threat-model.md.
 *
 * The rules:
 *   - reject absolute paths and any `..` segment
 *   - reject everything that is not a plain file or directory (no symlinks,
 *     hardlinks, devices, FIFOs)
 *   - enforce the size and file-count caps WHILE streaming, not afterwards
 *
 * Every violation is recorded and reported after the stream drains, never
 * thrown from inside the filter: tar invokes the filter from a stream event
 * handler, so a throw there escapes as an uncaught exception instead of
 * rejecting the promise we are awaiting. (Found by the test for the size cap,
 * which hung rather than failing.)
 *
 * Once a limit is breached the filter rejects everything that follows, so no
 * further bytes reach the disk. The stream still drains, but the compressed
 * size was already capped in the fetch phase, so that work is bounded.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { extract as tarExtract } from 'tar';
import { BuildError, type BuilderConfig, type Logger } from '@platform/core';

export interface ExtractResult {
  /** Repository root, after unwrapping the archive's single top-level directory. */
  rootDir: string;
  fileCount: number;
  totalBytes: number;
}

const MAX_REPORTED_VIOLATIONS = 5;

export function isSafeEntryPath(entryPath: string): boolean {
  if (entryPath.length === 0) return false;
  if (entryPath.includes('\0')) return false;
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(entryPath)) return false; // C:\ style
  return !entryPath.split(/[\\/]/).some((segment) => segment === '..');
}

export async function extractSource(
  archivePath: string,
  cfg: BuilderConfig,
  log: Logger,
): Promise<ExtractResult> {
  const stagingDir = path.join(cfg.workDir, 'source');
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const violations: string[] = [];
  // Annotated explicitly: assigned inside the filter closure, which stops
  // TypeScript narrowing it usefully at the throw site below.
  let limitError: BuildError | undefined;
  let fileCount = 0;
  let totalBytes = 0;

  await tarExtract({
    file: archivePath,
    cwd: stagingDir,
    strict: true,
    // Belt and braces: tar also strips these itself, but we want a loud failure
    // rather than a silent sanitisation.
    preservePaths: false,
    filter: (entryPath, entry) => {
      // A limit was already breached: admit nothing further.
      if (limitError) return false;

      // tar types this as `Stats | ReadEntry`; during extraction it is always a
      // ReadEntry, but narrow properly rather than casting.
      const entryType = 'type' in entry ? entry.type : undefined;

      if (entryType !== 'File' && entryType !== 'Directory') {
        violations.push(`${entryType ?? 'unknown'} entry rejected: ${entryPath}`);
        return false;
      }
      if (!isSafeEntryPath(entryPath)) {
        violations.push(`unsafe path rejected: ${entryPath}`);
        return false;
      }

      if (entryType === 'File') {
        fileCount += 1;
        totalBytes += entry.size ?? 0;

        if (fileCount > cfg.maxSourceFiles) {
          limitError = new BuildError(
            'SOURCE_ERROR',
            `repository contains more than ${cfg.maxSourceFiles} files`,
            { limit: cfg.maxSourceFiles },
          );
          return false;
        }
        if (totalBytes > cfg.maxSourceBytes) {
          limitError = new BuildError(
            'SOURCE_ERROR',
            `repository expands to more than ${mb(cfg.maxSourceBytes)} MB`,
            { limit: cfg.maxSourceBytes },
          );
          return false;
        }
      }
      return true;
    },
  });

  // Limits first: a zip bomb is a more urgent finding than a stray bad path.
  const breach: BuildError | undefined = limitError;
  if (breach) {
    await rm(stagingDir, { recursive: true, force: true });
    throw breach;
  }

  if (violations.length > 0) {
    await rm(stagingDir, { recursive: true, force: true });
    const shown = violations.slice(0, MAX_REPORTED_VIOLATIONS);
    const more = violations.length - shown.length;
    throw new BuildError(
      'SOURCE_ERROR',
      `archive contains ${violations.length} unsafe entr${violations.length === 1 ? 'y' : 'ies'}: ` +
        shown.join('; ') +
        (more > 0 ? ` (and ${more} more)` : ''),
      { violations: shown },
    );
  }

  const rootDir = await unwrapSingleRoot(stagingDir);
  log.info('source extracted', { fileCount, totalBytes, rootDir });
  return { rootDir, fileCount, totalBytes };
}

/**
 * GitHub tarballs wrap everything in one directory (`owner-repo-sha/`), while a
 * hand-rolled `tar -czf` usually does not. Detect rather than assume: if the
 * staging directory holds exactly one directory and nothing else, step into it.
 */
async function unwrapSingleRoot(stagingDir: string): Promise<string> {
  const entries = await readdir(stagingDir, { withFileTypes: true });
  if (entries.length === 0) {
    throw new BuildError('SOURCE_ERROR', 'archive is empty');
  }
  const [only] = entries;
  if (entries.length === 1 && only?.isDirectory()) {
    return path.join(stagingDir, only.name);
  }
  return stagingDir;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
