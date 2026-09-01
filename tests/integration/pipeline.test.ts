import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { EXIT } from '@platform/core';
import { fixture, runBuilder } from '../helpers.js';

/**
 * These run the bundled builder as a real subprocess, so the assertions are on
 * the exit code a container would actually produce. No network needed: every
 * fixture here either needs no build step or fails before install.
 */

describe('builder — end to end, no network', () => {
  it('builds a plain static site and publishes it', async () => {
    const run = await runBuilder([fixture('static-ok')], { DEPLOYMENT_ID: 'dep_static1' });
    try {
      expect(run.code).toBe(EXIT.OK);
      expect(run.result).toMatchObject({ status: 'DEPLOYED', framework: 'static' });

      const published = path.join(run.outputDir, 'dep_static1');
      const entries = await readdir(published);
      expect(entries).toContain('index.html');
      expect(entries).toContain('assets');

      const html = await readFile(path.join(published, 'index.html'), 'utf8');
      expect(html).toContain('static-ok');

      // Nested directories survive the copy.
      const about = await readFile(path.join(published, 'about', 'index.html'), 'utf8');
      expect(about).toContain('about');
    } finally {
      await run.cleanup();
    }
  });

  it('writes a manifest beside the artifacts, not inside them', async () => {
    const run = await runBuilder([fixture('static-ok')], { DEPLOYMENT_ID: 'dep_manifest' });
    try {
      const manifest = JSON.parse(
        await readFile(path.join(run.outputDir, 'dep_manifest.manifest.json'), 'utf8'),
      );
      expect(manifest.deploymentId).toBe('dep_manifest');
      expect(manifest.fileCount).toBeGreaterThan(0);

      const index = manifest.files.find((f: { path: string }) => f.path === 'index.html');
      expect(index.contentType).toBe('text/html; charset=utf-8');
      expect(index.cacheControl).toMatch(/must-revalidate/);

      // The manifest must not be inside the served directory.
      const served = await readdir(path.join(run.outputDir, 'dep_manifest'));
      expect(served).not.toContain('manifest.json');
    } finally {
      await run.cleanup();
    }
  });

  it('rejects an unrecognised framework with exit 11', async () => {
    const run = await runBuilder([fixture('no-framework')]);
    try {
      expect(run.code).toBe(EXIT.UNSUPPORTED_FRAMEWORK);
      expect(run.result).toMatchObject({ status: 'FAILED', code: 'UNSUPPORTED_FRAMEWORK' });
    } finally {
      await run.cleanup();
    }
  });

  it('rejects Next.js without static export, and explains why', async () => {
    const run = await runBuilder([fixture('next-no-export')]);
    try {
      expect(run.code).toBe(EXIT.UNSUPPORTED_FRAMEWORK);
      const failure = run.lines.find((l) => l.phase === 'failed');
      expect(String(failure?.msg)).toMatch(/output: 'export'/);
    } finally {
      await run.cleanup();
    }
  });

  it('rejects a repository with nothing servable', async () => {
    const run = await runBuilder([fixture('no-index')]);
    try {
      expect(run.code).toBe(EXIT.UNSUPPORTED_FRAMEWORK);
    } finally {
      await run.cleanup();
    }
  });

  it('refuses a zip-slip archive with exit 10 and publishes nothing', async () => {
    const run = await runBuilder([fixture('zip-slip')], { DEPLOYMENT_ID: 'dep_slip' });
    try {
      expect(run.code).toBe(EXIT.SOURCE_ERROR);
      expect(run.result).toMatchObject({ status: 'FAILED', code: 'SOURCE_ERROR' });
      await expect(readdir(path.join(run.outputDir, 'dep_slip'))).rejects.toThrow();
    } finally {
      await run.cleanup();
    }
  });

  it('refuses a symlink archive with exit 10', async () => {
    const run = await runBuilder([fixture('symlink-escape')]);
    try {
      expect(run.code).toBe(EXIT.SOURCE_ERROR);
    } finally {
      await run.cleanup();
    }
  });

  it('fails with exit 20 on a missing source, before doing any work', async () => {
    const run = await runBuilder([path.join('does', 'not', 'exist.tar.gz')]);
    try {
      expect(run.code).toBe(EXIT.SOURCE_ERROR);
    } finally {
      await run.cleanup();
    }
  });

  it('fails with exit 20 when OUTPUT_DIR is missing', async () => {
    const run = await runBuilder([fixture('static-ok')], { OUTPUT_DIR: '' });
    try {
      expect(run.code).toBe(EXIT.CONFIG_ERROR);
      expect(run.stderr).toMatch(/OUTPUT_DIR/);
    } finally {
      await run.cleanup();
    }
  });

  it('emits one JSON object per line, always ending with a result', async () => {
    const run = await runBuilder([fixture('static-ok')]);
    try {
      expect(run.lines.length).toBeGreaterThan(3);
      for (const line of run.lines) {
        expect(typeof line.ts).toBe('string');
        expect(typeof line.phase).toBe('string');
      }
      expect(run.lines.at(-1)?.phase).toBe('result');
    } finally {
      await run.cleanup();
    }
  });

  it('passes its own health check', async () => {
    const run = await runBuilder(['doctor']);
    try {
      expect(run.code).toBe(0);
      const names = run.lines.map((l) => l.check);
      expect(names).toContain('node-version');
      expect(names).toContain('npm-available');
      expect(names).toContain('tar-module');
    } finally {
      await run.cleanup();
    }
  });
});
