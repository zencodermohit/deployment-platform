/**
 * Phase 3 — install: fetch the project's dependencies.
 *
 * Lifecycle scripts RUN here. `preinstall` and `postinstall` from the repository
 * and from every package in its dependency tree execute with our permissions.
 * That is the whole reason this process lives in a disposable container with a
 * two-line IAM policy and no credentials worth stealing.
 *
 * We deliberately do not pass `--ignore-scripts`. It would break most real
 * projects, and it would be security theatre: `npm run build` executes arbitrary
 * code seconds later regardless. See docs/04-build-contract.md.
 */

import { BuildError, type BuilderConfig, type Logger } from '@platform/core';
import { resolveNpm, run } from '../exec.js';

export async function installDependencies(
  rootDir: string,
  hasLockfile: boolean,
  cfg: BuilderConfig,
  log: Logger,
  timeoutMs: number,
): Promise<void> {
  const { command, prefixArgs } = resolveNpm();

  // `npm ci` is faster and reproducible, but requires a lockfile that matches
  // package.json. Without one it refuses outright, so fall back.
  const npmArgs = hasLockfile
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];

  if (!hasLockfile) {
    log.warn('no package-lock.json; falling back to `npm install` (builds are not reproducible)');
  }

  const result = await run(command, [...prefixArgs, ...npmArgs], {
    cwd: rootDir,
    logger: log,
    timeoutMs,
    maxOldSpaceMb: heapCapMb(cfg),
  });

  if (result.timedOut) {
    throw new BuildError('TIMEOUT', 'dependency installation exceeded the time limit');
  }
  if (result.code !== 0) {
    throw new BuildError('INSTALL_FAILED', `npm ${npmArgs[0]} exited with code ${result.code}`, {
      exitCode: result.code,
    });
  }

  log.info('dependencies installed', { durationMs: result.durationMs });
}

/**
 * Keep Node's heap below the container's memory limit, so a memory-hungry build
 * throws a catchable JavaScript heap error instead of being SIGKILLed by the
 * kernel — which would destroy the logs explaining what happened.
 */
export function heapCapMb(cfg: BuilderConfig): number {
  const containerMb = Number(process.env['CONTAINER_MEMORY_MB'] ?? 2048);
  void cfg;
  return Math.max(512, Math.floor(containerMb * 0.75));
}
