import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

/**
 * End-to-end suite. Runs real `npm install` against the public registry, so it
 * needs network access and takes minutes rather than milliseconds. Kept out of
 * the default `npm test` deliberately — see docs/08-testing.md.
 */
export default defineConfig({
  resolve: {
    alias: { '@platform/core': core },
  },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    globalSetup: ['tests/setup/global.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
