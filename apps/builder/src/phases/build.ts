/**
 * Phase 4 — build: run the framework's build command.
 *
 * The command comes from the framework table in @platform/core, keyed by what
 * we detected. It is never read from the repository's `scripts` field and never
 * passed through a shell.
 */

import { BuildError, type BuilderConfig, type Framework, type Logger } from '@platform/core';
import { resolveNpm, run } from '../exec.js';
import { heapCapMb } from './install.js';

export async function runBuild(
  rootDir: string,
  framework: Framework,
  cfg: BuilderConfig,
  log: Logger,
  timeoutMs: number,
): Promise<void> {
  if (framework.buildCommand === null) {
    log.info('framework needs no build step; using repository contents as-is');
    return;
  }

  const [head, ...rest] = framework.buildCommand;
  if (head !== 'npm') {
    throw new BuildError('INTERNAL', `unsupported build command head: ${String(head)}`);
  }

  const { command, prefixArgs } = resolveNpm();
  const result = await run(command, [...prefixArgs, ...rest], {
    cwd: rootDir,
    logger: log,
    timeoutMs,
    maxOldSpaceMb: heapCapMb(cfg),
  });

  if (result.timedOut) {
    throw new BuildError('TIMEOUT', 'build exceeded the time limit');
  }
  if (result.code !== 0) {
    throw new BuildError(
      'BUILD_FAILED',
      `${framework.buildCommand.join(' ')} exited with code ${result.code}`,
      { exitCode: result.code },
    );
  }

  log.info('build completed', { durationMs: result.durationMs });
}
