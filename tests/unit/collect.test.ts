import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cacheControlFor,
  contentTypeFor,
  FRAMEWORKS,
  isBuildError,
  loadConfig,
  Logger,
  type LocalConfig,
} from '@platform/core';
import { collectArtifacts } from '../../apps/builder/src/phases/collect.js';
import { mapWithConcurrency } from '../../apps/builder/src/phases/publish.js';
import { withTempDir } from '../helpers.js';

function silent(): Logger {
  return new Logger({ deploymentId: 'test', write: () => {} });
}

function config(overrides: Partial<LocalConfig> = {}): LocalConfig {
  const base = loadConfig({ BUILDER_MODE: 'local', OUTPUT_DIR: '/out', SOURCE_PATH: '/x.tar.gz' });
  if (base.mode !== 'local') throw new Error('expected a local config');
  return { ...base, ...overrides };
}

async function makeRepo(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');
  }
}

describe('collectArtifacts', () => {
  it('fails with NO_OUTPUT when the build produced no output directory', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, { 'package.json': '{}' });
      const err = await collectArtifacts(dir, FRAMEWORKS.vite, config(), silent()).catch((e) => e);

      expect(isBuildError(err)).toBe(true);
      expect(err.code).toBe('NO_OUTPUT');
      expect(err.exitCode).toBe(14);
      expect(err.message).toMatch(/produced no "dist" directory/);
    });
  });

  it('fails with NO_OUTPUT when the output directory is empty', async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, 'dist'), { recursive: true });
      const err = await collectArtifacts(dir, FRAMEWORKS.vite, config(), silent()).catch((e) => e);

      expect(err.code).toBe('NO_OUTPUT');
      expect(err.message).toMatch(/empty/);
    });
  });

  it('fails with ARTIFACT_TOO_LARGE past the byte cap', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, { 'dist/index.html': 'x'.repeat(5000) });
      const err = await collectArtifacts(
        dir,
        FRAMEWORKS.vite,
        config({ maxArtifactBytes: 1000 }),
        silent(),
      ).catch((e) => e);

      expect(err.code).toBe('ARTIFACT_TOO_LARGE');
      expect(err.exitCode).toBe(15);
    });
  });

  it('collects a nested tree with correct relative paths and metadata', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, {
        'dist/index.html': '<!doctype html>',
        'dist/assets/app.a1b2c3d4.js': 'console.log(1)',
        'dist/assets/logo.svg': '<svg/>',
      });
      const result = await collectArtifacts(dir, FRAMEWORKS.vite, config(), silent());

      const byPath = Object.fromEntries(result.files.map((f) => [f.relPath, f]));
      expect(Object.keys(byPath).sort()).toEqual([
        'assets/app.a1b2c3d4.js',
        'assets/logo.svg',
        'index.html',
      ]);
      expect(byPath['index.html']?.contentType).toBe('text/html; charset=utf-8');
      expect(byPath['assets/logo.svg']?.contentType).toBe('image/svg+xml');
      expect(result.totalBytes).toBeGreaterThan(0);
    });
  });

  it('skips node_modules and .git for a plain static site', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, {
        'index.html': '<!doctype html>',
        'node_modules/junk/index.js': 'x',
        '.git/config': 'x',
      });
      const result = await collectArtifacts(dir, FRAMEWORKS.static, config(), silent());
      expect(result.files.map((f) => f.relPath)).toEqual(['index.html']);
    });
  });
});

describe('cache and content rules', () => {
  it('caches fingerprinted assets forever and revalidates HTML', () => {
    expect(cacheControlFor('assets/app.a1b2c3d4.js')).toMatch(/immutable/);
    expect(cacheControlFor('index.html')).toMatch(/must-revalidate/);
    expect(cacheControlFor('about/index.html')).toMatch(/must-revalidate/);
    // Unfingerprinted assets must revalidate, or a rollback would not be seen.
    expect(cacheControlFor('assets/app.js')).toMatch(/must-revalidate/);
    expect(cacheControlFor('service-worker.js')).toMatch(/must-revalidate/);
  });

  it('falls back to a safe content type for unknown extensions', () => {
    expect(contentTypeFor('weird.qqq')).toBe('application/octet-stream');
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
    expect(contentTypeFor('style.CSS')).toBe('text/css; charset=utf-8');
  });
});

describe('mapWithConcurrency', () => {
  it('processes every item without exceeding the limit', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];
    let active = 0;
    let peak = 0;

    await mapWithConcurrency(items, 8, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(n);
      active -= 1;
    });

    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles an empty list', async () => {
    await expect(mapWithConcurrency([], 8, async () => {})).resolves.toBeUndefined();
  });
});
