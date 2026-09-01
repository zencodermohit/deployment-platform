import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

/**
 * Integration suite against real AWS.
 *
 * Deliberately real DynamoDB rather than LocalStack. The thing under test here
 * is conditional-write semantics under concurrency — LocalStack reimplements
 * those, so passing against it would prove the reimplementation works, not that
 * our idempotency does. Everything that is pure logic is already covered by the
 * fast local suite.
 *
 * Costs a fraction of a cent per run on an on-demand table.
 */
export default defineConfig({
  resolve: {
    alias: { '@platform/core': core },
  },
  test: {
    include: ['tests/aws/**/*.test.ts'],
    globalSetup: ['tests/setup/aws.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
