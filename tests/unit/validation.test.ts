import { describe, expect, it } from 'vitest';
import {
  RepositoryUrlError,
  branchSchema,
  commitShaSchema,
  createDeploymentSchema,
  createProjectSchema,
  parseRepositoryUrl,
  statusCallbackSchema,
} from '../../apps/api/src/validation/schemas.js';

describe('parseRepositoryUrl — accepts', () => {
  it('a plain GitHub URL', () => {
    expect(parseRepositoryUrl('https://github.com/octocat/hello-world')).toEqual({
      repositoryUrl: 'https://github.com/octocat/hello-world',
      owner: 'octocat',
      repo: 'hello-world',
    });
  });

  it('normalises a .git suffix, a trailing slash, and surrounding space', () => {
    for (const input of [
      'https://github.com/octocat/hello-world.git',
      'https://github.com/octocat/hello-world/',
      '  https://github.com/octocat/hello-world  ',
      'https://GitHub.com/octocat/hello-world',
    ]) {
      expect(parseRepositoryUrl(input).repositoryUrl, input).toBe(
        'https://github.com/octocat/hello-world',
      );
    }
  });

  it('names with dots, dashes and underscores', () => {
    const parsed = parseRepositoryUrl('https://github.com/my-org/my.repo_name');
    expect(parsed.owner).toBe('my-org');
    expect(parsed.repo).toBe('my.repo_name');
  });
});

describe('parseRepositoryUrl — rejects', () => {
  const cases: [string, unknown][] = [
    ['SSRF to instance metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['SSRF over https to metadata', 'https://169.254.169.254/'],
    ['a lookalike host', 'https://github.com.evil.io/a/b'],
    ['a subdomain of an attacker domain', 'https://evil.io/github.com/a/b'],
    ['a github subdomain', 'https://raw.github.com/a/b'],
    ['plain http', 'http://github.com/a/b'],
    ['embedded credentials', 'https://user:pass@github.com/a/b'],
    ['a username only', 'https://user@github.com/a/b'],
    ['an explicit port', 'https://github.com:8080/a/b'],
    ['a file URL', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/plain,hello'],
    ['an ssh remote', 'git@github.com:octocat/hello-world.git'],
    ['too few path segments', 'https://github.com/octocat'],
    ['too many path segments', 'https://github.com/octocat/repo/tree/main'],
    ['no path at all', 'https://github.com/'],
    ['a query string', 'https://github.com/a/b?x=1'],
    ['a fragment', 'https://github.com/a/b#readme'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { url: 'https://github.com/a/b' }],
  ];

  it.each(cases)('%s', (_label, input) => {
    expect(() => parseRepositoryUrl(input)).toThrow(RepositoryUrlError);
  });

  it('rejects an over-long URL before doing any work', () => {
    expect(() => parseRepositoryUrl('https://github.com/a/' + 'x'.repeat(4000))).toThrow(
      /too long/,
    );
  });
});

describe('parseRepositoryUrl — traversal is normalised away, not rejected', () => {
  /**
   * `new URL()` collapses `..` before we ever inspect the path, so
   * `github.com/../etc/passwd` becomes `github.com/etc/passwd` — a perfectly
   * ordinary owner/repo pair that simply does not exist.
   *
   * That is the whole reason the threat model says to parse with `URL` and
   * never a regex: the parser defuses the attack, and what we store is the
   * normalised result rather than the string the caller sent. An earlier
   * version of this file expected a rejection here, which was wrong about the
   * code rather than finding a hole in it.
   */
  it('collapses traversal into a plain owner/repo pair', () => {
    const parsed = parseRepositoryUrl('https://github.com/../etc/passwd');
    expect(parsed.owner).toBe('etc');
    expect(parsed.repo).toBe('passwd');
    expect(parsed.repositoryUrl).toBe('https://github.com/etc/passwd');
  });

  it('never stores a url containing ".."', () => {
    for (const input of [
      'https://github.com/../etc/passwd',
      'https://github.com/a/../../etc/passwd',
      'https://github.com/./octocat/./hello-world',
    ]) {
      const parsed = parseRepositoryUrl(input);
      expect(parsed.repositoryUrl, input).not.toContain('..');
      expect(parsed.repositoryUrl, input).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    }
  });

  it('still rejects traversal that collapses to no repository at all', () => {
    // github.com/a/b/../.. normalises to github.com/, which has no owner/repo.
    expect(() => parseRepositoryUrl('https://github.com/a/b/../..')).toThrow(RepositoryUrlError);
  });
});

describe('branch names', () => {
  it('accepts ordinary refs', () => {
    for (const branch of ['main', 'feature/login', 'release-1.2.3', 'user/fix_bug', 'v2']) {
      expect(branchSchema.safeParse(branch).success, branch).toBe(true);
    }
  });

  it('rejects shell metacharacters', () => {
    // Defence in depth: refs are passed as one argv element, never to a shell.
    for (const branch of [
      'main; rm -rf /',
      'main && curl evil.com',
      'main | sh',
      'main`whoami`',
      'main$(id)',
      'main\nrm -rf /',
      "main'; DROP TABLE--",
      'main&background',
      'main>out.txt',
    ]) {
      expect(branchSchema.safeParse(branch).success, branch).toBe(false);
    }
  });

  it('rejects git ref names that are not legal anyway', () => {
    for (const branch of ['..', 'a/../b', '-delete', '/leading', 'trailing/', 'x.lock', '']) {
      expect(branchSchema.safeParse(branch).success, branch).toBe(false);
    }
  });

  it('rejects an over-long ref', () => {
    expect(branchSchema.safeParse('a'.repeat(256)).success).toBe(false);
  });
});

describe('commit sha', () => {
  it('accepts a full lowercase sha', () => {
    expect(commitShaSchema.safeParse('a'.repeat(40)).success).toBe(true);
  });

  it('rejects short, uppercase, and non-hex', () => {
    for (const sha of ['abc123', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41), '']) {
      expect(commitShaSchema.safeParse(sha).success, sha).toBe(false);
    }
  });
});

describe('createDeploymentSchema', () => {
  it('accepts an empty body — branch falls back to the project default', () => {
    expect(createDeploymentSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a branch, sha and idempotency key', () => {
    const result = createDeploymentSchema.safeParse({
      branch: 'main',
      commitSha: 'b'.repeat(40),
      idempotencyKey: 'cli:2026-09-01:a1b2',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bad branch even when everything else is fine', () => {
    expect(
      createDeploymentSchema.safeParse({ branch: 'main; rm -rf /', commitSha: 'c'.repeat(40) })
        .success,
    ).toBe(false);
  });

  it('does not accept a repositoryUrl — that lives on the project', () => {
    // Accepting one here would let a caller point an existing project at an
    // arbitrary repository. Zod strips unknown keys rather than erroring, so
    // assert the parsed output does not carry it through.
    const result = createDeploymentSchema.parse({
      branch: 'main',
      repositoryUrl: 'https://github.com/attacker/evil',
    } as never);
    expect(result).not.toHaveProperty('repositoryUrl');
  });
});

describe('createProjectSchema', () => {
  it('defaults the branch to main', () => {
    const result = createProjectSchema.parse({
      name: 'my blog',
      repositoryUrl: 'https://github.com/octocat/hello-world',
    });
    expect(result.defaultBranch).toBe('main');
  });

  it('rejects a name that starts with punctuation', () => {
    for (const name of ['', ' leading', '-dash', '.hidden', 'x'.repeat(101)]) {
      expect(createProjectSchema.safeParse({ name, repositoryUrl: 'https://x' }).success, name).toBe(
        false,
      );
    }
  });
});

describe('statusCallbackSchema', () => {
  it('accepts a progress report', () => {
    expect(statusCallbackSchema.safeParse({ status: 'BUILDING', phase: 'install' }).success).toBe(
      true,
    );
  });

  it('accepts a failure with an error payload', () => {
    expect(
      statusCallbackSchema.safeParse({
        status: 'FAILED',
        error: { code: 'BUILD_FAILED', message: 'exit 13', exitCode: 13 },
      }).success,
    ).toBe(true);
  });

  it('refuses states the container has no business setting', () => {
    // The container cannot claim a deployment or cancel one.
    for (const status of ['QUEUED', 'PROVISIONING', 'CANCELLED', 'nonsense']) {
      expect(statusCallbackSchema.safeParse({ status }).success, status).toBe(false);
    }
  });

  it('caps an error message so a hostile build cannot flood the record', () => {
    expect(
      statusCallbackSchema.safeParse({
        status: 'FAILED',
        error: { code: 'X', message: 'y'.repeat(5000) },
      }).success,
    ).toBe(false);
  });
});
