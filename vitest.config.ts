import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@platform/core': core },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globalSetup: ['tests/setup/global.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
