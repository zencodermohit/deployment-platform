/**
 * Bundle the builder into a single file with esbuild.
 *
 * Why bundle at all: the runtime image then needs no node_modules, which keeps
 * the image that runs untrusted code small and its dependency surface minimal.
 *
 * Why esbuild and not tsc: esbuild compiles, tsc type-checks. They are different
 * jobs, not alternatives. `npm run typecheck` runs tsc separately.
 * See docs/08-testing.md.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const result = await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'dist/builder.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false, // readable stack traces matter more than bytes here
  legalComments: 'none',
  banner: {
    // node-tar and friends still reach for CommonJS globals in places.
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
      "import { fileURLToPath as __f } from 'node:url';",
      "import { dirname as __d } from 'node:path';",
      'const __filename = __f(import.meta.url);',
      'const __dirname = __d(__filename);',
    ].join('\n'),
  },
  alias: {
    '@platform/core': resolve(root, 'packages/core/src/index.ts'),
  },
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`bundle: ${(bytes / 1024).toFixed(1)} KB`);
