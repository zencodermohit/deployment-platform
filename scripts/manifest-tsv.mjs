/**
 * Print a build manifest as TSV: path, contentType, cacheControl.
 *
 * Exists so the publish script does not depend on jq, which is not installed
 * everywhere (notably not in Git Bash on Windows). Node always is — it built
 * the manifest in the first place.
 *
 *   node scripts/manifest-tsv.mjs .out/dep_x.manifest.json
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: manifest-tsv.mjs <manifest.json>\n');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(file, 'utf8'));
for (const entry of manifest.files ?? []) {
  process.stdout.write([entry.path, entry.contentType, entry.cacheControl].join('\t') + '\n');
}
