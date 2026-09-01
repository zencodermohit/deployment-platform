/**
 * M6 — sessions, and the spend bound that matters regardless of who is calling.
 *
 * Against the real test table, because the interesting parts are the atomic
 * quota increment and the fact that a session is stored only as a hash.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { generateSessionId, generateUserId, sessionKey } from '@platform/core';
import {
  consumeDailyQuota,
  createSession,
  deleteSession,
  documentClient,
  getSession,
  getUser,
  getUserByGithubId,
  hashToken,
  putUser,
  tableName,
} from '@platform/data';

const cleanup: { PK: string; SK: string }[] = [];

beforeAll(() => {
  expect(tableName()).toMatch(/-test$/);
});

afterAll(async () => {
  for (const key of cleanup) {
    await documentClient().send(new DeleteCommand({ TableName: tableName(), Key: key }));
  }
});

function track(pk: string, sk: string): void {
  cleanup.push({ PK: pk, SK: sk });
}

describe('sessions', () => {
  it('issues a token that resolves back to its user', async () => {
    const userId = generateUserId();
    const token = generateSessionId();
    track(`SESSION#${hashToken(token)}`, 'META');

    const created = await createSession(userId, token);
    expect(created.userId).toBe(userId);

    const resolved = await getSession(token);
    expect(resolved?.userId).toBe(userId);
  });

  it('stores only a hash — the token itself is never written', async () => {
    const userId = generateUserId();
    const token = generateSessionId();
    track(`SESSION#${hashToken(token)}`, 'META');
    await createSession(userId, token);

    const raw = await documentClient().send(
      new GetCommand({
        TableName: tableName(),
        Key: sessionKey(hashToken(token)),
        ConsistentRead: true,
      }),
    );

    // A leaked backup must contain no usable credential.
    const serialised = JSON.stringify(raw.Item);
    expect(serialised).not.toContain(token);
    expect(raw.Item?.['PK']).toBe(`SESSION#${hashToken(token)}`);
  });

  it('rejects a token that was never issued', async () => {
    expect(await getSession(generateSessionId())).toBeNull();
  });

  it('rejects an expired session even before TTL sweeps it', async () => {
    // DynamoDB TTL deletion is best-effort and can lag by hours, so expiry is
    // checked in code as well. Treating a not-yet-swept row as valid would be a
    // real hole.
    const userId = generateUserId();
    const token = generateSessionId();
    const hash = hashToken(token);
    track(`SESSION#${hash}`, 'META');

    await createSession(userId, token);
    await documentClient().send(
      new (await import('@aws-sdk/lib-dynamodb')).UpdateCommand({
        TableName: tableName(),
        Key: sessionKey(hash),
        UpdateExpression: 'SET expiresAt = :past',
        ExpressionAttributeValues: { ':past': new Date(Date.now() - 1000).toISOString() },
      }),
    );

    expect(await getSession(token)).toBeNull();
  });

  it('revokes immediately on logout', async () => {
    const userId = generateUserId();
    const token = generateSessionId();
    track(`SESSION#${hashToken(token)}`, 'META');

    await createSession(userId, token);
    expect(await getSession(token)).not.toBeNull();

    // Revocation working at all is the reason these are opaque tokens rather
    // than JWTs (docs/03-api.md).
    await deleteSession(token);
    expect(await getSession(token)).toBeNull();
  });

  it('two sessions for the same user are independent', async () => {
    const userId = generateUserId();
    const a = generateSessionId();
    const b = generateSessionId();
    track(`SESSION#${hashToken(a)}`, 'META');
    track(`SESSION#${hashToken(b)}`, 'META');

    await createSession(userId, a);
    await createSession(userId, b);
    await deleteSession(a);

    expect(await getSession(a)).toBeNull();
    expect(await getSession(b)).not.toBeNull();
  });
});

describe('users', () => {
  it('is found by GitHub id, not by login', async () => {
    const userId = generateUserId();
    const githubId = String(Date.now());
    track(`USER#${userId}`, 'PROFILE');

    await putUser({
      userId,
      githubId,
      login: 'octocat',
      email: 'octocat@example.com',
      avatarUrl: null,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    });

    let found = null;
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      found = await getUserByGithubId(githubId);
      if (!found) await new Promise((r) => setTimeout(r, 500));
    }

    expect(found?.userId).toBe(userId);
    expect(await getUser(userId)).not.toBeNull();
  });

  it('a returning login keeps the same user id even if the login changed', async () => {
    const userId = generateUserId();
    const githubId = String(Date.now() + 1);
    track(`USER#${userId}`, 'PROFILE');

    const base = {
      userId,
      githubId,
      email: null,
      avatarUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await putUser({ ...base, login: 'old-name', lastLoginAt: '2026-01-01T00:00:00.000Z' });
    await putUser({ ...base, login: 'new-name', lastLoginAt: new Date().toISOString() });

    const user = await getUser(userId);
    expect(user?.login).toBe('new-name');
    // Usernames can be released and claimed by someone else; the numeric id
    // cannot. Matching on login would eventually hand one person another's
    // account.
    expect(user?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('daily deployment quota — threat T8', () => {
  it('allows up to the limit and refuses the next', async () => {
    const userId = generateUserId();
    const day = new Date().toISOString().slice(0, 10);
    track(`USER#${userId}`, `QUOTA#${day}`);

    for (let i = 0; i < 3; i++) {
      expect(await consumeDailyQuota(userId, 3), `attempt ${i + 1}`).toBe(true);
    }
    expect(await consumeDailyQuota(userId, 3)).toBe(false);
    expect(await consumeDailyQuota(userId, 3)).toBe(false);
  });

  it('is atomic: concurrent requests cannot both take the last slot', async () => {
    const userId = generateUserId();
    const day = new Date().toISOString().slice(0, 10);
    track(`USER#${userId}`, `QUOTA#${day}`);

    // Ten simultaneous requests against a limit of four. A read-then-write
    // implementation would let several of them see "3 used" and all proceed.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeDailyQuota(userId, 4)),
    );

    expect(results.filter(Boolean)).toHaveLength(4);
    expect(results.filter((r) => !r)).toHaveLength(6);
  });

  it('counts each user separately', async () => {
    const a = generateUserId();
    const b = generateUserId();
    const day = new Date().toISOString().slice(0, 10);
    track(`USER#${a}`, `QUOTA#${day}`);
    track(`USER#${b}`, `QUOTA#${day}`);

    expect(await consumeDailyQuota(a, 1)).toBe(true);
    expect(await consumeDailyQuota(a, 1)).toBe(false);
    // One user exhausting their quota must not affect anyone else.
    expect(await consumeDailyQuota(b, 1)).toBe(true);
  });

  it('sets a TTL so counters clean themselves up', async () => {
    const userId = generateUserId();
    const day = new Date().toISOString().slice(0, 10);
    track(`USER#${userId}`, `QUOTA#${day}`);
    await consumeDailyQuota(userId, 5);

    const result = await documentClient().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': `QUOTA#${day}` },
        ConsistentRead: true,
      }),
    );

    const ttlEpoch = Number(result.Items?.[0]?.['ttlEpoch']);
    expect(ttlEpoch).toBeGreaterThan(Date.now() / 1000);
  });
});
