import { describe, expect, it } from 'vitest';
import { DEFAULTS, describeConfig, isBuildError, loadConfig } from '@platform/core';

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
    expect(cfg.mode).toBe('local');
    if (cfg.mode !== 'local') throw new Error('expected a local config');
    expect(cfg.sourcePath).toBe('/other.tar.gz');
  });

  it('requires a source and an output directory', () => {
    expectConfigError({ BUILDER_MODE: 'local', OUTPUT_DIR: '/out' }, /no source tarball/i);
    expectConfigError({ BUILDER_MODE: 'local', SOURCE_PATH: '/x.tar.gz' }, /OUTPUT_DIR/);
  });

  it('rejects a mode that does not exist', () => {
    expectConfigError({ ...MINIMAL, BUILDER_MODE: 'azure' }, /must be "local" or "aws"/);
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

describe('loadConfig — aws mode', () => {
  const AWS = {
    BUILDER_MODE: 'aws',
    SOURCE_URL: 'https://bucket.s3.amazonaws.com/sources/dep_1.tar.gz?X-Amz-Signature=abc',
    ARTIFACT_BUCKET: 'platform-artifacts',
    ARTIFACT_PREFIX: 'projects/prj_1/deployments/dep_1',
    STATUS_URL: 'https://api.example.com/internal/deployments/dep_1/status',
    STATUS_TOKEN: 'stk_' + 'a'.repeat(64),
  };

  it('loads every required field', () => {
    const cfg = loadConfig(AWS);
    expect(cfg.mode).toBe('aws');
    if (cfg.mode !== 'aws') throw new Error('expected an aws config');

    expect(cfg.artifactBucket).toBe('platform-artifacts');
    expect(cfg.artifactPrefix).toBe('projects/prj_1/deployments/dep_1');
    expect(cfg.statusToken).toBe(AWS.STATUS_TOKEN);
  });

  it('treats the token and the presigned url as secrets to redact', () => {
    const cfg = loadConfig(AWS);
    // Both are credentials: one authorises status writes, the other grants read
    // access to the source archive. Neither may appear in a log line.
    expect(cfg.secrets).toContain(AWS.STATUS_TOKEN);
    expect(cfg.secrets).toContain(AWS.SOURCE_URL);
  });

  it('keeps secrets out of the loggable description', () => {
    const described = JSON.stringify(describeConfig(loadConfig(AWS)));
    expect(described).not.toContain(AWS.STATUS_TOKEN);
    expect(described).not.toContain('X-Amz-Signature');
  });

  it('requires each field, naming the one that is missing', () => {
    for (const key of ['SOURCE_URL', 'ARTIFACT_BUCKET', 'ARTIFACT_PREFIX', 'STATUS_URL', 'STATUS_TOKEN']) {
      const env = { ...AWS } as Record<string, string>;
      delete env[key];
      expectConfigError(env, new RegExp(key));
    }
  });

  it('refuses a source url that is not https', () => {
    expectConfigError({ ...AWS, SOURCE_URL: 'http://bucket/x.tar.gz' }, /must be an https URL/);
  });

  it('refuses an artifact prefix that could escape its namespace', () => {
    // The prefix becomes an S3 key and an IAM resource pattern. It is generated
    // by the control plane, but a bug there must not silently become a bug here.
    expectConfigError({ ...AWS, ARTIFACT_PREFIX: '/absolute/path' }, /relative path/);
    expectConfigError({ ...AWS, ARTIFACT_PREFIX: 'projects/../../other' }, /relative path/);
  });

  it('normalises a trailing slash on the prefix', () => {
    const cfg = loadConfig({ ...AWS, ARTIFACT_PREFIX: 'projects/prj_1/deployments/dep_1/' });
    if (cfg.mode !== 'aws') throw new Error('expected an aws config');
    expect(cfg.artifactPrefix).toBe('projects/prj_1/deployments/dep_1');
  });

  it('needs no OUTPUT_DIR or SOURCE_PATH', () => {
    expect(() => loadConfig(AWS)).not.toThrow();
  });
});
