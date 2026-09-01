import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { EXIT } from '@platform/core';
import { fixture, runBuilder } from '../helpers.js';

/**
 * The M1 exit criterion, verified for real: a Vite project goes in, a working
 * dist/ comes out, and a broken build exits 13.
 *
 * Runs a genuine `npm install` against the public registry, so it needs network
 * access and takes minutes. Not part of `npm test` — run with `npm run test:e2e`.
 */

describe('builder — real npm install and build', () => {
  it('builds a Vite project and publishes the output', async () => {
    const run = await runBuilder([fixture('vite-ok')], {
      DEPLOYMENT_ID: 'dep_vite',
      BUILD_TIMEOUT_SEC: '540',
    });
    try {
      expect(run.result?.code ?? run.result?.status).toBeDefined();
      expect(run.code, run.stdout.slice(-4000)).toBe(EXIT.OK);
      expect(run.result).toMatchObject({ status: 'DEPLOYED', framework: 'vite' });

      const published = path.join(run.outputDir, 'dep_vite');
      const entries = await readdir(published);
      expect(entries).toContain('index.html');
      expect(entries).toContain('assets');

      const html = await readFile(path.join(published, 'index.html'), 'utf8');
      expect(html).toContain('<script');
      // Vite rewrites the dev-time /src/main.js reference to a hashed bundle.
      expect(html).not.toContain('/src/main.js');

      const assets = await readdir(path.join(published, 'assets'));
      expect(assets.some((f) => /\.js$/.test(f))).toBe(true);
    } finally {
      await run.cleanup();
    }
  });

  it('exits 13 when the build command fails', async () => {
    const run = await runBuilder([fixture('build-fails')], {
      DEPLOYMENT_ID: 'dep_broken',
      BUILD_TIMEOUT_SEC: '540',
    });
    try {
      expect(run.code).toBe(EXIT.BUILD_FAILED);
      expect(run.result).toMatchObject({ status: 'FAILED', code: 'BUILD_FAILED', userFault: true });

      // The failure must be explained in the logs, not just in the exit code.
      const output = run.stdout.toLowerCase();
      expect(output).toMatch(/resolve|not found|error/);

      await expect(readdir(path.join(run.outputDir, 'dep_broken'))).rejects.toThrow();
    } finally {
      await run.cleanup();
    }
  });

  it('kills a build that overruns its deadline', async () => {
    const run = await runBuilder([fixture('vite-ok')], { BUILD_TIMEOUT_SEC: '5' });
    try {
      expect(run.code).toBe(EXIT.TIMEOUT);
      expect(run.stdout).toMatch(/watchdog|deadline|time limit/i);
    } finally {
      await run.cleanup();
    }
  });
});
