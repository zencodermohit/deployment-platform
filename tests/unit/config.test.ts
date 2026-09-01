import { describe, expect, it } from 'vitest';
import { DEFAULTS, isBuildError, loadConfig } from '@platform/core';

const MINIMAL = { BUILDER_MODE: 'local', OUTPUT_DIR: '/out', SOURCE_PATH: '/in/src.tar.gz' };

function expectConfigError(env: NodeJS.ProcessEnv, match: RegExp): void {
  try {
    loadConfig(env);
    throw new Error('expected loadConfig to throw');
  } catch (e) {
    expect(isBuildError(e)).toBe(true);
    if (isBuildError(e)) {
      expect(e.code).toBe('CONFIG_ERROR');
      expect(e.exitCode).toBe(20);
      expect(e.message).toMatch(match);
    }
  }
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const cfg = loadConfig(MINIMAL);
    expect(cfg.buildTimeoutSec).toBe(DEFAULTS.buildTimeoutSec);
    expect(cfg.maxArchiveBytes).toBe(DEFAULTS.maxArchiveBytes);
    expect(cfg.maxArtifactBytes).toBe(DEFAULTS.maxArtifactBytes);
    expect(cfg.logLevel).toBe('info');
  });

  it('generates an unguessable deployment id when none is given', () => {
    const a = loadConfig(MINIMAL).deploymentId;
    const b = loadConfig(MINIMAL).deploymentId;

    expect(a).toMatch(/^dep_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('lets an explicit argument override SOURCE_PATH', () => {
    const cfg = loadConfig(MINIMAL, { sourcePath: '/other.tar.gz' });
    expect(cfg.sourcePath).toBe('/other.tar.gz');
  });

  it('requires a source and an output directory', () => {
    expectConfigError({ BUILDER_MODE: 'local', OUTPUT_DIR: '/out' }, /no source tarball/i);
    expectConfigError({ BUILDER_MODE: 'local', SOURCE_PATH: '/x.tar.gz' }, /OUTPUT_DIR/);
  });

  it('rejects an unimplemented mode rather than half-working', () => {
    expectConfigError({ ...MINIMAL, BUILDER_MODE: 'aws' }, /only "local" exists/);
  });

  it('rejects non-numeric and out-of-range numbers', () => {
    expectConfigError({ ...MINIMAL, BUILD_TIMEOUT_SEC: 'soon' }, /whole number/);
    expectConfigError({ ...MINIMAL, BUILD_TIMEOUT_SEC: '1.5' }, /whole number/);
    expectConfigError({ ...MINIMAL, BUILD_TIMEOUT_SEC: '0' }, /between/);
    expectConfigError({ ...MINIMAL, BUILD_TIMEOUT_SEC: '99999' }, /between/);
  });

  it('rejects an unknown log level', () => {
    expectConfigError({ ...MINIMAL, LOG_LEVEL: 'chatty' }, /debug\|info\|warn\|error/);
  });

  it('treats blank strings as absent', () => {
    const cfg = loadConfig({ ...MINIMAL, DEPLOYMENT_ID: '   ' });
    expect(cfg.deploymentId).toMatch(/^dep_/);
  });
});
