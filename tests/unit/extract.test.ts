import { describe, expect, it } from 'vitest';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSafeEntryPath, extractSource } from '../../apps/builder/src/phases/extract.js';
import { loadConfig, Logger, isBuildError, type BuilderConfig } from '@platform/core';
import { fixture, withTempDir } from '../helpers.js';

function silentLogger(): Logger {
  return new Logger({ deploymentId: 'test', write: () => {} });
}

function config(workDir: string, overrides: Partial<BuilderConfig> = {}): BuilderConfig {
  const base = loadConfig(
    { BUILDER_MODE: 'local', OUTPUT_DIR: path.join(workDir, 'out') },
    { sourcePath: 'unused' },
  );
  return { ...base, workDir, ...overrides };
}

describe('isSafeEntryPath', () => {
  it('accepts ordinary relative paths', () => {
    for (const p of ['index.html', 'src/main.js', 'a/b/c/d.txt', './x.txt']) {
      expect(isSafeEntryPath(p), p).toBe(true);
    }
  });

  it('rejects traversal, absolute paths, and null bytes', () => {
    for (const p of [
      '../evil.txt',
      '../../evil.txt',
      'a/../../evil.txt',
      'a/b/../../../evil',
      '/etc/passwd',
      '\\windows\\system32',
      'C:/Windows/System32/evil.dll',
      'c:\\evil',
      'bad\0name',
      '',
    ]) {
      expect(isSafeEntryPath(p), p).toBe(false);
    }
  });

  it('does not reject filenames that merely contain dots', () => {
    for (const p of ['..hidden', 'a..b.txt', 'file..', 'v1.2..3/x']) {
      expect(isSafeEntryPath(p), p).toBe(true);
    }
  });
});

describe('extractSource — hostile archives', () => {
  it('refuses an archive containing a path that escapes the destination', async () => {
    await withTempDir(async (dir) => {
      const cfg = config(dir);
      const err = await extractSource(fixture('zip-slip'), cfg, silentLogger()).catch((e) => e);

      expect(isBuildError(err)).toBe(true);
      expect(err.code).toBe('SOURCE_ERROR');
      expect(err.message).toMatch(/unsafe/i);

      // And nothing landed outside the staging directory.
      const escaped = path.resolve(dir, '..', '..', 'evil.txt');
      await expect(stat(escaped)).rejects.toThrow();
    });
  });

  it('refuses an archive containing a symlink', async () => {
    await withTempDir(async (dir) => {
      const cfg = config(dir);
      const err = await extractSource(fixture('symlink-escape'), cfg, silentLogger()).catch((e) => e);

      expect(isBuildError(err)).toBe(true);
      expect(err.code).toBe('SOURCE_ERROR');
      expect(err.message).toMatch(/SymbolicLink|rejected/i);
    });
  });

  it('refuses an archive containing an absolute path', async () => {
    await withTempDir(async (dir) => {
      const cfg = config(dir);
      const err = await extractSource(fixture('absolute-path'), cfg, silentLogger()).catch((e) => e);

      expect(isBuildError(err)).toBe(true);
      expect(err.code).toBe('SOURCE_ERROR');
    });
  });

  it('aborts when the archive exceeds the uncompressed size cap', async () => {
    await withTempDir(async (dir) => {
      const cfg = config(dir, { maxSourceBytes: 10 });
      const err = await extractSource(fixture('static-ok'), cfg, silentLogger()).catch((e) => e);

      expect(isBuildError(err)).toBe(true);
      expect(err.code).toBe('SOURCE_ERROR');
      expect(err.message).toMatch(/expands to more than/i);
    });
  });

  it('aborts when the archive exceeds the file-count cap', async () => {
    await withTempDir(async (dir) => {
      const cfg = config(dir, { maxSourceFiles: 1 });
      const err = await extractSource(fixture('static-ok'), cfg, silentLogger()).catch((e) => e);

      expect(isBuildError(err)).toBe(true);
      expect(err.message).toMatch(/more than 1 files/i);
    });
  });
});

describe('extractSource — well-formed archives', () => {
  it('extracts a normal archive and reports its size', async () => {
    await withTempDir(async (dir) => {
      const cfg = config(dir);
      const result = await extractSource(fixture('static-ok'), cfg, silentLogger());

      expect(result.fileCount).toBeGreaterThan(0);
      expect(result.totalBytes).toBeGreaterThan(0);

      const entries = await readdir(result.rootDir);
      expect(entries).toContain('index.html');
      expect(entries).toContain('assets');
    });
  });
});
