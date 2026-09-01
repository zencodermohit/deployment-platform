/**
 * Bundle each worker into its own file.
 *
 * Separate bundles rather than one shared function: these have genuinely
 * different triggers (SQS, EventBridge, a schedule) and genuinely different
 * permissions — the dispatcher can run ECS tasks, the sweeper cannot. That is
 * exactly the case where splitting buys real isolation, unlike the API routes
 * in ADR-0010.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

for (const name of ['dispatcher', 'reconciler', 'sweeper']) {
  const result = await build({
    entryPoints: [resolve(here, `src/${name}.ts`)],
    outfile: resolve(here, `dist/${name}.mjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: false,
    legalComments: 'none',
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module';",
        'const require = __cr(import.meta.url);',
      ].join('\n'),
    },
    alias: {
      '@platform/core': resolve(root, 'packages/core/src/index.ts'),
      '@platform/data': resolve(root, 'packages/data/src/index.ts'),
    },
    logLevel: 'warning',
    metafile: true,
  });

  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(`${name}: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}
