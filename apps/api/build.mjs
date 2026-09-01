/**
 * Bundle the API into a single file for Lambda.
 *
 * The AWS SDK is bundled rather than left external. The Lambda runtime does
 * ship a copy, but its version drifts with the runtime and pinning ours makes
 * the deployed artifact reproducible — the same bundle behaves the same way
 * regardless of when Lambda last updated. Costs a few hundred KB.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const result = await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'dist/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  alias: {
    '@platform/core': resolve(root, 'packages/core/src/index.ts'),
  },
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`api bundle: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
