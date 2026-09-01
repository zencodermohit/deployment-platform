import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Resolve the throwaway test table from Terraform output, so the suite can
 * never be pointed at the real one by a stale environment variable.
 */
export default function setup(): void {
  if (process.env['TABLE_NAME']) {
    if (!process.env['TABLE_NAME'].endsWith('-test')) {
      throw new Error(
        `refusing to run integration tests against "${process.env['TABLE_NAME']}" — ` +
          'the table name must end in "-test"',
      );
    }
    return;
  }

  const out = execFileSync(
    'terraform',
    ['-chdir=' + path.join(root, 'infra', 'stacks', 'app'), 'output', '-raw', 'test_table_name'],
    { encoding: 'utf8' },
  ).trim();

  if (!out.endsWith('-test')) {
    throw new Error(`unexpected test table name from terraform: "${out}"`);
  }

  process.env['TABLE_NAME'] = out;
  console.log(`integration tests using table: ${out}`);
}
