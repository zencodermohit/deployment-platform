/**
 * Environment configuration, parsed and validated once at startup.
 *
 * Deliberately hand-rolled rather than using Zod: this is a small fixed set of
 * variables we control, and every dependency added here ends up inside the
 * container that runs untrusted code. Zod arrives at the API layer (M3), where
 * request bodies are attacker-controlled and genuinely complex.
 *
 * M1 implements `local` mode only. `aws` mode slots in at the marked seam.
 */

import { BuildError } from './errors.js';
import { generateDeploymentId } from './ids.js';

export type BuilderMode = 'local';

export interface BuilderConfig {
  mode: BuilderMode;
  deploymentId: string;

  /** Path to the source tarball. In AWS mode this becomes a presigned URL. */
  sourcePath: string;
  /** Where finished artifacts are written. In AWS mode this becomes bucket + prefix. */
  outputDir: string;
  /** Scratch space. Wiped on start; must be writable. */
  workDir: string;

  buildTimeoutSec: number;
  /** Compressed archive cap, checked before anything is unpacked. */
  maxArchiveBytes: number;
  /** Uncompressed cap, enforced while unpacking (zip-bomb defence). */
  maxSourceBytes: number;
  maxSourceFiles: number;
  maxArtifactBytes: number;
  maxArtifactFiles: number;
  maxLogBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /** Values scrubbed from every log line. Empty in local mode; populated in AWS mode. */
  secrets: string[];
}

const MB = 1024 * 1024;

export const DEFAULTS = {
  buildTimeoutSec: 600,
  maxArchiveBytes: 100 * MB,
  maxSourceBytes: 500 * MB,
  maxSourceFiles: 20_000,
  maxArtifactBytes: 500 * MB,
  maxArtifactFiles: 20_000,
  maxLogBytes: 10 * MB,
} as const;

export interface ConfigOverrides {
  sourcePath?: string;
  outputDir?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): BuilderConfig {
  const mode = (env['BUILDER_MODE'] ?? 'local').trim();
  if (mode !== 'local') {
    // --- SEAM: `aws` mode lands here in M4 (presigned URL, S3 target, status API). ---
    throw new BuildError('CONFIG_ERROR', `unsupported BUILDER_MODE "${mode}"; only "local" exists in M1`);
  }

  const sourcePath = overrides.sourcePath ?? str(env, 'SOURCE_PATH');
  if (!sourcePath) {
    throw new BuildError(
      'CONFIG_ERROR',
      'no source tarball given. Pass a path as an argument, or set SOURCE_PATH.',
    );
  }

  const outputDir = overrides.outputDir ?? str(env, 'OUTPUT_DIR');
  if (!outputDir) {
    throw new BuildError('CONFIG_ERROR', 'OUTPUT_DIR is required in local mode.');
  }

  return {
    mode: 'local',
    deploymentId: str(env, 'DEPLOYMENT_ID') ?? generateDeploymentId(),
    sourcePath,
    outputDir,
    workDir: str(env, 'WORK_DIR') ?? '/workspace',
    buildTimeoutSec: int(env, 'BUILD_TIMEOUT_SEC', DEFAULTS.buildTimeoutSec, 1, 3600),
    maxArchiveBytes: int(env, 'MAX_ARCHIVE_BYTES', DEFAULTS.maxArchiveBytes, 1024, 5_000 * MB),
    maxSourceBytes: int(env, 'MAX_SOURCE_BYTES', DEFAULTS.maxSourceBytes, 1024, 5_000 * MB),
    maxSourceFiles: int(env, 'MAX_SOURCE_FILES', DEFAULTS.maxSourceFiles, 1, 1_000_000),
    maxArtifactBytes: int(env, 'MAX_ARTIFACT_BYTES', DEFAULTS.maxArtifactBytes, 1024, 5_000 * MB),
    maxArtifactFiles: int(env, 'MAX_ARTIFACT_FILES', DEFAULTS.maxArtifactFiles, 1, 1_000_000),
    maxLogBytes: int(env, 'MAX_LOG_BYTES', DEFAULTS.maxLogBytes, 1024, 1_000 * MB),
    logLevel: level(env, 'LOG_LEVEL'),
    secrets: [],
  };
}

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function int(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new BuildError('CONFIG_ERROR', `${key} must be a whole number, got "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new BuildError('CONFIG_ERROR', `${key} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function level(env: NodeJS.ProcessEnv, key: string): BuilderConfig['logLevel'] {
  const raw = (str(env, key) ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  throw new BuildError('CONFIG_ERROR', `${key} must be debug|info|warn|error, got "${raw}"`);
}

/** Config as loggable fields. Never includes anything from `secrets`. */
export function describeConfig(c: BuilderConfig): Record<string, unknown> {
  return {
    mode: c.mode,
    sourcePath: c.sourcePath,
    outputDir: c.outputDir,
    workDir: c.workDir,
    buildTimeoutSec: c.buildTimeoutSec,
    maxArtifactBytes: c.maxArtifactBytes,
    maxArtifactFiles: c.maxArtifactFiles,
  };
}
