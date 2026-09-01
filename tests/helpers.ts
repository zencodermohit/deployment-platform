import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILDER = path.join(ROOT, 'apps', 'builder', 'dist', 'builder.mjs');
export const TARBALLS = path.join(ROOT, 'tests', 'fixtures', 'tarballs');

export function fixture(name: string): string {
  return path.join(TARBALLS, `${name}.tar.gz`);
}

export interface LogLine {
  level: string;
  phase: string;
  msg: string;
  [key: string]: unknown;
}

export interface BuilderRun {
  code: number;
  stdout: string;
  stderr: string;
  lines: LogLine[];
  result: LogLine | undefined;
  outputDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Run the bundled builder as a real subprocess, so tests assert on the exit code
 * the container would actually produce — not on a function's return value.
 */
export async function runBuilder(
  args: string[],
  env: Record<string, string> = {},
): Promise<BuilderRun> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'builder-test-'));
  const outputDir = path.join(scratch, 'out');
  const workDir = path.join(scratch, 'work');

  let stdout: string;
  let stderr: string;
  let code = 0;

  try {
    const res = await execFileAsync(process.execPath, [BUILDER, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        ComSpec: process.env['ComSpec'] ?? '',
        BUILDER_MODE: 'local',
        OUTPUT_DIR: outputDir,
        WORK_DIR: workDir,
        ...env,
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    code = typeof err.code === 'number' ? err.code : 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }

  const lines = stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as LogLine);

  return {
    code,
    stdout,
    stderr,
    lines,
    result: lines.find((l) => l.phase === 'result'),
    outputDir,
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'builder-unit-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
