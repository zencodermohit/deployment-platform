import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Runs once before any test file. Generates fixtures and bundles the builder,
 * so the integration tests exercise the same artifact the Docker image ships.
 */
export default function setup(): void {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'make-fixtures.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [path.join(root, 'apps', 'builder', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
}
