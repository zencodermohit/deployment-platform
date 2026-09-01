/**
 * Generate the test fixtures: small repositories, packed into tarballs.
 *
 * Two kinds:
 *
 *   Normal fixtures are real directories packed with node-tar.
 *
 *   Malicious fixtures (zip-slip, symlink) cannot be produced that way — you
 *   cannot put a file at `../../evil.txt` on disk and pack it. So we write the
 *   tar headers by hand. That matters: a security test built from an
 *   approximation of the attack proves nothing about the real one.
 *
 * Run with: npm run fixtures
 */

import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcDir = path.join(root, 'tests', 'fixtures', 'src');
const outDir = path.join(root, 'tests', 'fixtures', 'tarballs');

/* ------------------------------------------------------------------ *
 * Normal fixtures
 * ------------------------------------------------------------------ */

const FIXTURES = {
  'static-ok': {
    'index.html':
      '<!doctype html><html><head><title>Static OK</title></head>' +
      '<body><h1>static-ok</h1><script src="/assets/app.js"></script></body></html>',
    'assets/app.js': 'console.log("static-ok");\n',
    'about/index.html': '<!doctype html><title>About</title><h1>about</h1>',
  },

  'vite-ok': {
    'package.json': JSON.stringify(
      {
        name: 'vite-ok',
        private: true,
        type: 'module',
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^5.4.11' },
      },
      null,
      2,
    ),
    'index.html':
      '<!doctype html><html><head><title>Vite OK</title></head>' +
      '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>',
    'src/main.js':
      'document.querySelector("#app").textContent = "built by the platform";\n',
  },

  // Exit 13: the build command fails. The import cannot be resolved.
  'build-fails': {
    'package.json': JSON.stringify(
      {
        name: 'build-fails',
        private: true,
        type: 'module',
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^5.4.11' },
      },
      null,
      2,
    ),
    'index.html':
      '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>',
    'src/main.js': 'import "./this-module-does-not-exist.js";\n',
  },

  // Exit 11: a build script, but nothing we recognise.
  'no-framework': {
    'package.json': JSON.stringify(
      { name: 'mystery', private: true, scripts: { build: 'make all' } },
      null,
      2,
    ),
    'src/main.c': 'int main(void){return 0;}\n',
  },

  // Exit 11: Next.js without static export produces a server, not files.
  'next-no-export': {
    'package.json': JSON.stringify(
      {
        name: 'next-server',
        private: true,
        scripts: { build: 'next build' },
        dependencies: { next: '^15.0.0', react: '^19.0.0' },
      },
      null,
      2,
    ),
    'next.config.js': 'module.exports = { reactStrictMode: true };\n',
  },

  // Detected as Next.js, static export. Not built in tests (needs the network).
  'next-export': {
    'package.json': JSON.stringify(
      {
        name: 'next-static',
        private: true,
        scripts: { build: 'next build' },
        dependencies: { next: '^15.0.0', react: '^19.0.0' },
      },
      null,
      2,
    ),
    'next.config.js': "module.exports = { output: 'export' };\n",
  },

  // Exit 11: a package.json with no build script and no index.html to fall
  // back to. There is nothing here we could serve.
  'no-index': {
    'package.json': JSON.stringify({ name: 'no-index', private: true }, null, 2),
    'readme.md': '# nothing to deploy\n',
  },
};

/* ------------------------------------------------------------------ *
 * Hand-written tar, for the archives that cannot exist on disk
 * ------------------------------------------------------------------ */

const BLOCK = 512;

/** One 512-byte USTAR header. */
function tarHeader({ name, size = 0, type = '0', linkname = '' }) {
  const buf = Buffer.alloc(BLOCK, 0);
  const put = (text, offset, length) =>
    buf.write(String(text).slice(0, length - 1), offset, length - 1, 'utf8');
  const octal = (value, offset, length) =>
    buf.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'utf8');

  put(name, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.floor(Date.now() / 1000), 136, 12);
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder: eight spaces
  buf.write(type, 156, 1, 'utf8');
  put(linkname, 157, 100);
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

function tarEntry(header, body = Buffer.alloc(0)) {
  const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return Buffer.concat([header, body, Buffer.alloc(padding, 0)]);
}

async function writeRawTarball(name, entries) {
  const chunks = entries.map(({ body = '', ...header }) => {
    const payload = Buffer.from(body, 'utf8');
    return tarEntry(tarHeader({ ...header, size: payload.length }), payload);
  });
  // Two zero blocks terminate a tar archive.
  chunks.push(Buffer.alloc(BLOCK * 2, 0));

  const target = path.join(outDir, `${name}.tar.gz`);
  await pipeline(Readable.from(Buffer.concat(chunks)), createGzip(), createWriteStream(target));
  console.log(`  ${name}.tar.gz  (hand-written)`);
}

/* ------------------------------------------------------------------ */

async function main() {
  await rm(srcDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log('normal fixtures:');
  for (const [name, files] of Object.entries(FIXTURES)) {
    const dir = path.join(srcDir, name);
    for (const [rel, contents] of Object.entries(files)) {
      const file = path.join(dir, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, 'utf8');
    }
    await create({ gzip: true, cwd: dir, file: path.join(outDir, `${name}.tar.gz`) }, ['.']);
    console.log(`  ${name}.tar.gz`);
  }

  console.log('malicious fixtures:');

  // Zip slip: an entry that climbs out of the extraction directory.
  await writeRawTarball('zip-slip', [
    { name: 'index.html', body: '<!doctype html><title>decoy</title>' },
    { name: '../../evil.txt', body: 'if you can read this at ../../ the guard failed\n' },
  ]);

  // A symlink pointing at a host file. Object storage has no symlinks, and
  // following one during extraction is how you leak /etc/passwd into a build.
  await writeRawTarball('symlink-escape', [
    { name: 'index.html', body: '<!doctype html><title>decoy</title>' },
    { name: 'passwd-link', type: '2', linkname: '/etc/passwd' },
  ]);

  // An absolute path, which must never be honoured.
  await writeRawTarball('absolute-path', [
    { name: 'index.html', body: '<!doctype html><title>decoy</title>' },
    { name: '/tmp/absolute-escape.txt', body: 'nope\n' },
  ]);

  console.log(`\nfixtures written to ${path.relative(root, outDir)}`);
}

await main();
