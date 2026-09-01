/**
 * Health check — `builder doctor`.
 *
 * A note on Docker HEALTHCHECK: it is meant for long-running services, where the
 * daemon re-probes a container every 30s. This container is a one-shot batch job
 * that exits when the build ends, so a HEALTHCHECK instruction would be
 * meaningless at runtime.
 *
 * What IS useful is running this at image build time (`RUN node dist/builder.mjs
 * doctor`), which turns "the image is missing npm" from a mystery failure on the
 * first real deployment into a failed `docker build`. That is where it is wired
 * up — see docker/builder/Dockerfile.
 */

import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveNpm, run } from './exec.js';
import { Logger } from '@platform/core';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed advisory check is reported but does not fail the run. */
  advisory?: boolean;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node-version',
    ok: Number.isFinite(major) && major >= MIN_NODE_MAJOR,
    detail: `node ${process.version} (need >= ${MIN_NODE_MAJOR})`,
  });

  checks.push(await checkNpm());

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  checks.push({
    name: 'non-root',
    ok: uid === null || uid !== 0,
    detail: uid === null ? 'uid unavailable on this platform' : `running as uid ${uid}`,
    // On Windows there is no uid; on Linux running as root is a real finding.
    advisory: uid === null,
  });

  const workDir = process.env['WORK_DIR'] ?? '/workspace';
  checks.push(await checkWritable('work-dir-writable', workDir));

  const outputDir = process.env['OUTPUT_DIR'];
  if (outputDir) {
    checks.push(await checkWritable('output-dir-writable', outputDir));
  }

  checks.push(await checkTarModule());

  const ok = checks.every((c) => c.ok || c.advisory === true);
  return { ok, checks };
}

async function checkNpm(): Promise<Check> {
  try {
    const { command, prefixArgs } = resolveNpm();
    const captured: string[] = [];
    const logger = new Logger({
      deploymentId: 'doctor',
      minLevel: 'debug',
      write: (line) => captured.push(line),
    });
    const result = await run(command, [...prefixArgs, '--version'], {
      cwd: process.cwd(),
      logger,
      timeoutMs: 30_000,
    });
    return {
      name: 'npm-available',
      ok: result.code === 0,
      detail: result.code === 0 ? 'npm responded to --version' : `npm exited ${result.code}`,
    };
  } catch (e) {
    return {
      name: 'npm-available',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkWritable(name: string, dir: string): Promise<Check> {
  const probe = path.join(dir, `.doctor-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    await writeFile(probe, 'ok', 'utf8');
    await rm(probe, { force: true });
    return { name, ok: true, detail: `${dir} is writable` };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: `${dir}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function checkTarModule(): Promise<Check> {
  try {
    const mod = await import('tar');
    return {
      name: 'tar-module',
      ok: typeof mod.extract === 'function',
      detail: 'tar.extract is callable',
    };
  } catch (e) {
    return {
      name: 'tar-module',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
