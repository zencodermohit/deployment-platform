/**
 * Builder entrypoint.
 *
 *   builder [build] <source.tar.gz>   run a build
 *   builder doctor                    self-check the image and environment
 *   builder help
 *
 * Everything is reported as JSON lines on stdout, and the process exit code is
 * the machine-readable result. See docs/04-build-contract.md.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  BuildError,
  describeConfig,
  EXIT,
  loadConfig,
  Logger,
  toBuildError,
  type BuilderConfig,
} from '@platform/core';
import { killActiveChild } from './exec.js';
import { runDoctor } from './health.js';
import { createReporter, type Reporter } from './reporter.js';
import { fetchSource } from './phases/fetch.js';
import { extractSource } from './phases/extract.js';
import { inspectProject } from './phases/inspect.js';
import { installDependencies } from './phases/install.js';
import { runBuild } from './phases/build.js';
import { collectArtifacts } from './phases/collect.js';
import { publishArtifacts } from './phases/publish.js';

const VERBS = new Set(['build', 'doctor', 'help', '--help', '-h']);

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  const verb = first !== undefined && VERBS.has(first) ? first : 'build';
  const args = first !== undefined && VERBS.has(first) ? argv.slice(1) : argv;

  if (verb === 'help' || verb === '--help' || verb === '-h') {
    printUsage();
    return EXIT.OK;
  }

  if (verb === 'doctor') {
    const { ok, checks } = await runDoctor();
    for (const check of checks) {
      process.stdout.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: check.ok ? 'info' : check.advisory ? 'warn' : 'error',
          phase: 'doctor',
          check: check.name,
          ok: check.ok,
          msg: check.detail,
        }) + '\n',
      );
    }
    return ok ? EXIT.OK : 1;
  }

  return runPipeline(args[0]);
}

async function runPipeline(sourceArg: string | undefined): Promise<number> {
  const startedAt = Date.now();

  // Config is loaded before the logger, because the logger needs the deployment
  // ID and the redaction list. A config error therefore reports plainly.
  let cfg: BuilderConfig;
  try {
    cfg = loadConfig(process.env, sourceArg ? { sourcePath: sourceArg } : {});
  } catch (e) {
    const err = toBuildError(e, 'CONFIG_ERROR');
    process.stderr.write(`configuration error: ${err.message}\n`);
    return err.exitCode;
  }

  const log = new Logger({
    deploymentId: cfg.deploymentId,
    redact: cfg.secrets,
    minLevel: cfg.logLevel,
    maxTotalBytes: cfg.maxLogBytes,
  });

  const reporter: Reporter = createReporter(cfg, log);
  const deadline = startedAt + cfg.buildTimeoutSec * 1000;
  const remaining = (): number => Math.max(1_000, deadline - Date.now());

  // The watchdog is the in-container half of the timeout. The other half is an
  // external StopTask, because a wedged process will not kill itself.
  const watchdog = setTimeout(() => {
    log.phase('timeout').error('watchdog fired; build exceeded its deadline', {
      buildTimeoutSec: cfg.buildTimeoutSec,
    });
    killActiveChild();
    emitResult(log, cfg, 'FAILED', EXIT.TIMEOUT, startedAt, { code: 'TIMEOUT' });
    process.exit(EXIT.TIMEOUT);
  }, cfg.buildTimeoutSec * 1000);

  try {
    log.info('builder starting', describeConfig(cfg));

    // A stale work directory would let one build see another's files.
    await emptyDir(cfg.workDir);

    const { archivePath } = await fetchSource(cfg, log.phase('fetch'));
    const { rootDir } = await extractSource(archivePath, cfg, log.phase('fetch'));
    const { framework, hasLockfile } = await inspectProject(rootDir, log.phase('inspect'));

    // PROVISIONING -> BUILDING. Reported once the source is known-good, so a
    // deployment that fails on a bad archive never claims to have built.
    await reporter.report({ status: 'BUILDING', phase: 'install', framework: framework.id });

    if (framework.needsInstall) {
      await installDependencies(rootDir, hasLockfile, cfg, log.phase('install'), remaining());
    }

    await runBuild(rootDir, framework, cfg, log.phase('build'), remaining());

    const collected = await collectArtifacts(rootDir, framework, cfg, log.phase('collect'));

    await reporter.report({
      status: 'UPLOADING',
      phase: 'upload',
      framework: framework.id,
      fileCount: collected.files.length,
      artifactBytes: collected.totalBytes,
    });

    const published = await publishArtifacts(collected, cfg, log.phase('publish'));

    await reporter.report({
      status: 'DEPLOYED',
      phase: 'done',
      framework: framework.id,
      fileCount: published.fileCount,
      artifactBytes: published.totalBytes,
    });

    clearTimeout(watchdog);
    emitResult(log, cfg, 'DEPLOYED', EXIT.OK, startedAt, {
      framework: framework.id,
      fileCount: published.fileCount,
      totalBytes: published.totalBytes,
      destination: published.destination,
    });
    return EXIT.OK;
  } catch (e) {
    clearTimeout(watchdog);
    killActiveChild();

    const err: BuildError = toBuildError(e);
    log.phase('failed').error(err.message, { code: err.code, ...err.detail });

    // Best-effort: if this cannot be delivered, the reconciler notices the task
    // stopped without a terminal state and fails the deployment itself.
    await reporter.report({
      status: 'FAILED',
      error: { code: err.code, message: err.message, exitCode: err.exitCode },
    });

    emitResult(log, cfg, 'FAILED', err.exitCode, startedAt, {
      code: err.code,
      userFault: err.isUserFault,
    });
    return err.exitCode;
  }
}

/**
 * Empty a directory without removing the directory itself.
 *
 * `rm(dir, { recursive: true })` would delete the directory too, and deleting a
 * directory needs write permission on its PARENT. In the container /workspace
 * sits directly under /, which root owns, so the unprivileged build user gets
 * EACCES. Locally the work directory sat inside a folder we owned, so this only
 * appeared once the container actually ran.
 */
async function emptyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  await Promise.all(
    entries.map((entry) => rm(path.join(dir, entry), { recursive: true, force: true })),
  );
}

/**
 * The last line of every run, success or failure. In M4 this is also where the
 * status callback to the control plane goes.
 */
function emitResult(
  log: Logger,
  cfg: BuilderConfig,
  status: 'DEPLOYED' | 'FAILED',
  exitCode: number,
  startedAt: number,
  extra: Record<string, unknown>,
): void {
  log.phase('result').info(`deployment ${status.toLowerCase()}`, {
    status,
    exitCode,
    durationMs: Date.now() - startedAt,
    deploymentId: cfg.deploymentId,
    ...extra,
  });
}

function printUsage(): void {
  process.stdout.write(
    [
      'builder — turns a source tarball into publishable static artifacts',
      '',
      'Usage:',
      '  builder [build] <source.tar.gz>   build and publish',
      '  builder doctor                    self-check environment and image',
      '  builder help',
      '',
      'Required environment (local mode):',
      '  OUTPUT_DIR         where artifacts are written',
      '',
      'Optional:',
      '  SOURCE_PATH        tarball path, if not given as an argument',
      '  DEPLOYMENT_ID      defaults to a random dep_<hex>',
      '  WORK_DIR           scratch space (default /workspace)',
      '  BUILD_TIMEOUT_SEC  default 600',
      '  LOG_LEVEL          debug|info|warn|error (default info)',
      '',
      'Exit codes: 0 ok · 10 source · 11 framework · 12 install · 13 build',
      '            14 no output · 15 too large · 16 publish · 17 timeout',
      '            20 config · 70 internal',
      '',
    ].join('\n'),
  );
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    // Nothing should reach here; if it does, it is a builder bug, not a user fault.
    process.stderr.write(`unhandled builder error: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = EXIT.INTERNAL;
  });
