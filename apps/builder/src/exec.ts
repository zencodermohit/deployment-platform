/**
 * Running child processes safely.
 *
 * Three rules, each closing a specific hole:
 *
 * 1. `shell: false`, always. Arguments are passed as an array, so a branch named
 *    `main; rm -rf /` is a single meaningless argument rather than two commands.
 * 2. The child's environment is BUILT, not inherited. `process.env` in AWS holds
 *    the status token and presigned URL; a build script that dumps its
 *    environment must not find them.
 * 3. Every run has a deadline, enforced with SIGTERM then SIGKILL.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '@platform/core';

export interface RunOptions {
  cwd: string;
  logger: Logger;
  timeoutMs: number;
  /** Cap for the build's own heap, set below the container limit. */
  maxOldSpaceMb?: number;
}

export interface RunResult {
  code: number;
  timedOut: boolean;
  durationMs: number;
}

/** Tracked so the global watchdog can kill an in-flight build before exiting. */
let activeChild: ChildProcess | null = null;

export function killActiveChild(): void {
  if (activeChild && activeChild.exitCode === null) {
    try {
      activeChild.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * npm on Windows is `npm.cmd`, and Node refuses to spawn `.cmd` without a shell
 * (CVE-2024-27980). Rather than reach for `shell: true`, run npm's JS entrypoint
 * with the current Node binary. On Linux — which is what the container is — plain
 * `npm` works and this whole branch is skipped.
 */
export function resolveNpm(): { command: string; prefixArgs: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', prefixArgs: [] };

  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, prefixArgs: [candidate] };
  }
  throw new Error(
    'could not locate npm-cli.js next to the Node binary; npm commands cannot run on this host',
  );
}

/** An explicit, minimal environment. Nothing from the host leaks through. */
function buildChildEnv(opts: RunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? opts.cwd,
    CI: '1',
    NO_COLOR: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
  };

  if (opts.maxOldSpaceMb) {
    env['NODE_OPTIONS'] = `--max-old-space-size=${opts.maxOldSpaceMb}`;
  }

  // Windows genuinely needs these or child processes misbehave.
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'ComSpec', 'PATHEXT']) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }

  return env;
}

export function run(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();

  return new Promise<RunResult>((resolve) => {
    opts.logger.info(`exec: ${command} ${args.join(' ')}`, { cwd: opts.cwd });

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildChildEnv(opts),
      shell: false, // never true. see rule 1 above.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChild = child;

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const deadline = setTimeout(() => {
      timedOut = true;
      opts.logger.warn(`timed out after ${opts.timeoutMs}ms, terminating`);
      child.kill('SIGTERM');
      // A wedged process ignores SIGTERM. Give it 5s, then stop asking.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, opts.timeoutMs);

    pipeLines(child.stdout, (line) => opts.logger.child(line, 'stdout'));
    pipeLines(child.stderr, (line) => opts.logger.child(line, 'stderr'));

    const finish = (code: number): void => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      activeChild = null;
      resolve({ code, timedOut, durationMs: Date.now() - started });
    };

    child.on('error', (err) => {
      opts.logger.error(`failed to start process: ${err.message}`);
      finish(-1);
    });
    child.on('close', (code, signal) => {
      if (signal) opts.logger.warn(`process terminated by signal ${signal}`);
      finish(code ?? (signal ? 137 : -1));
    });
  });
}

/** Split a stream into whole lines so one log record is one line of output. */
function pipeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
    }
    // Guard against output with no newlines at all.
    if (buffer.length > 64 * 1024) {
      onLine(buffer);
      buffer = '';
    }
  });
  stream.on('end', () => {
    if (buffer.trim().length > 0) onLine(buffer);
  });
}
