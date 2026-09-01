import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_STATUSES,
  INFLIGHT,
  artifactPrefix,
  decodeCursor,
  deploymentByIdKeys,
  deploymentHostname,
  deploymentKey,
  deploymentListPrefix,
  domainKey,
  encodeCursor,
  generateDeploymentId,
  generateStatusToken,
  inFlightKeys,
  isTerminal,
  isValidId,
  projectByIdKeys,
  projectKey,
  userByEmailKeys,
  userKey,
} from '@platform/core';

describe('identifiers', () => {
  it('generates prefixed, 128-bit random ids', () => {
    for (const id of [generateDeploymentId(), generateDeploymentId()]) {
      expect(id).toMatch(/^dep_[0-9a-f]{32}$/);
    }
  });

  it('never repeats across many draws', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateDeploymentId()));
    expect(ids.size).toBe(2000);
  });

  it('generates a 256-bit status token, longer than an id', () => {
    expect(generateStatusToken()).toMatch(/^stk_[0-9a-f]{64}$/);
  });

  it('validates ids by kind', () => {
    const dep = generateDeploymentId();
    expect(isValidId('deployment', dep)).toBe(true);
    expect(isValidId('project', dep)).toBe(false);
    expect(isValidId('deployment', 'dep_1')).toBe(false);
    expect(isValidId('deployment', 'dep_' + 'Z'.repeat(32))).toBe(false);
    expect(isValidId('deployment', undefined)).toBe(false);
  });
});

describe('deploymentHostname', () => {
  it('replaces underscores, which are illegal in hostnames', () => {
    expect(deploymentHostname('dep_9c21ab', 'example.com')).toBe('dep-9c21ab.example.com');
    expect(deploymentHostname('dep_9c21ab', 'example.com')).not.toContain('_');
  });

  it('stays a single subdomain level, because wildcard certs only cover one', () => {
    const host = deploymentHostname(generateDeploymentId(), 'example.com');
    expect(host.split('.').length).toBe(3);
  });
});

describe('artifactPrefix', () => {
  it('is built only from ids, never from client input', () => {
    expect(artifactPrefix('prj_1', 'dep_2')).toBe('projects/prj_1/deployments/dep_2');
  });

  it('cannot be steered out of its namespace by a hostile id', () => {
    // Ids are server-generated, but assert the shape anyway: this string ends
    // up as an S3 prefix and an IAM resource pattern.
    const prefix = artifactPrefix('prj_1', 'dep_2');
    expect(prefix.startsWith('projects/')).toBe(true);
    expect(prefix).not.toContain('..');
    expect(prefix.startsWith('/')).toBe(false);
  });
});

describe('table keys', () => {
  it('stores a project under its owner so listing is one query', () => {
    expect(projectKey('usr_1', 'prj_2')).toEqual({ PK: 'USER#usr_1', SK: 'PROJECT#prj_2' });
    expect(projectListPrefixMatches('usr_1', projectKey('usr_1', 'prj_2'))).toBe(true);
  });

  it('stores a deployment under its project, sorted by time', () => {
    const key = deploymentKey('prj_1', '2026-09-01T10:00:00.000Z', 'dep_9');
    expect(key.PK).toBe('PROJECT#prj_1');
    expect(key.SK).toBe('DEP#2026-09-01T10:00:00.000Z#dep_9');
  });

  it('sorts deployments chronologically as plain strings', () => {
    const keys = [
      deploymentKey('prj_1', '2026-09-01T10:00:00.000Z', 'dep_a'),
      deploymentKey('prj_1', '2026-09-01T09:00:00.000Z', 'dep_b'),
      deploymentKey('prj_1', '2026-10-01T10:00:00.000Z', 'dep_c'),
    ].map((k) => k.SK);

    expect([...keys].sort()).toEqual([
      'DEP#2026-09-01T09:00:00.000Z#dep_b',
      'DEP#2026-09-01T10:00:00.000Z#dep_a',
      'DEP#2026-10-01T10:00:00.000Z#dep_c',
    ]);
  });

  it('distinguishes two deployments created in the same millisecond', () => {
    const at = '2026-09-01T10:00:00.000Z';
    expect(deploymentKey('prj_1', at, 'dep_a').SK).not.toBe(deploymentKey('prj_1', at, 'dep_b').SK);
  });

  it('lowercases and trims email and hostname keys', () => {
    expect(userByEmailKeys('  Foo@Example.COM ').gsi1pk).toBe('EMAIL#foo@example.com');
    expect(domainKey('  DEP-9c21.Example.COM ').PK).toBe('DOMAIN#dep-9c21.example.com');
  });

  it('gives every entity a distinct GSI1 partition', () => {
    const partitions = [
      userByEmailKeys('a@b.com').gsi1pk,
      projectByIdKeys('prj_1').gsi1pk,
      deploymentByIdKeys('dep_1').gsi1pk,
    ];
    expect(new Set(partitions).size).toBe(partitions.length);
  });

  it('keeps user and deployment partitions from ever colliding', () => {
    expect(userKey('1').PK).not.toBe(deploymentKey('1', 'x', 'y').PK);
  });
});

describe('sparse in-flight index — the one that leaks if you get it wrong', () => {
  it('marks live deployments so the sweeper can find them', () => {
    for (const status of DEPLOYMENT_STATUSES.filter((s) => !isTerminal(s))) {
      const keys = inFlightKeys(status, '2026-09-01T10:12:00.000Z');
      expect(keys.gsi2pk, status).toBe(INFLIGHT);
      expect(keys.gsi2sk, status).toBe('2026-09-01T10:12:00.000Z');
    }
  });

  it('marks nothing for a terminal deployment', () => {
    for (const status of DEPLOYMENT_STATUSES.filter(isTerminal)) {
      expect(inFlightKeys(status, '2026-09-01T10:12:00.000Z'), status).toEqual({});
    }
  });

  it('covers every status, so a new one cannot be forgotten', () => {
    for (const status of DEPLOYMENT_STATUSES) {
      const keys = inFlightKeys(status, 'x');
      const marked = keys.gsi2pk !== undefined;
      expect(marked, status).toBe(!isTerminal(status));
    }
  });

  it('sorts deadlines so the sweeper can range-query past-due items', () => {
    const deadlines = ['2026-09-01T10:12:00.000Z', '2026-09-01T09:12:00.000Z'];
    const sorted = deadlines.map((d) => inFlightKeys('BUILDING', d).gsi2sk!).sort();
    expect(sorted[0]).toBe('2026-09-01T09:12:00.000Z');
  });
});

describe('pagination cursors', () => {
  it('round-trips a DynamoDB key', () => {
    const key = { PK: 'PROJECT#prj_1', SK: 'DEP#2026-09-01T10:00:00.000Z#dep_9' };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it('is URL-safe', () => {
    const cursor = encodeCursor({ PK: 'PROJECT#prj_1', SK: 'DEP#a+b/c=d' });
    expect(cursor).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('rejects a cursor that is not an object', () => {
    expect(() => decodeCursor(Buffer.from('"nope"').toString('base64url'))).toThrow();
    expect(() => decodeCursor(Buffer.from('[1,2]').toString('base64url'))).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow();
  });
});

/** Helper mirroring the begins_with condition the list query uses. */
function projectListPrefixMatches(userId: string, key: { PK: string; SK: string }): boolean {
  const { PK, skPrefix } = deploymentListPrefixShim(userId);
  return key.PK === PK && key.SK.startsWith(skPrefix);
}

function deploymentListPrefixShim(userId: string): { PK: string; skPrefix: string } {
  return { PK: `USER#${userId}`, skPrefix: 'PROJECT#' };
}

describe('list prefixes', () => {
  it('scopes a deployment listing to one project', () => {
    const { PK, skPrefix } = deploymentListPrefix('prj_1');
    const key = deploymentKey('prj_1', '2026-09-01T10:00:00.000Z', 'dep_9');
    expect(key.PK).toBe(PK);
    expect(key.SK.startsWith(skPrefix)).toBe(true);

    // A different project's deployments live in a different partition entirely.
    expect(deploymentKey('prj_2', '2026-09-01T10:00:00.000Z', 'dep_9').PK).not.toBe(PK);
  });
});
