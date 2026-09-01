/**
 * Users and sessions.
 *
 * Sessions are opaque random tokens, stored ONLY as a SHA-256 hash. A leaked
 * database backup therefore contains no usable credential — the same reason
 * passwords are hashed. Lookup is by hash, so the plaintext token never needs
 * to exist server-side after issue.
 *
 * Not JWTs, deliberately: revocation actually works, there is no signing key to
 * leak, and at this scale the extra read costs nothing. See docs/03-api.md.
 */

import { createHash } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { sessionKey, userKey } from '@platform/core';
import { documentClient, isConditionalCheckFailure, tableName } from './table.js';

export interface User {
  userId: string;
  /** GitHub's numeric account id. Stable across username changes. */
  githubId: string;
  login: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string;
}

export interface Session {
  userId: string;
  createdAt: string;
  expiresAt: string;
  /**
   * Unix SECONDS, for DynamoDB's TTL sweeper.
   *
   * A separate field from `expiresAt` because that one is an ISO string for
   * humans and APIs, and TTL requires a number. Naming the TTL attribute
   * `expiresAt` too would mean one name holding two incompatible types.
   */
  ttlEpoch: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export async function getUser(userId: string): Promise<User | null> {
  const result = await documentClient().send(
    new GetCommand({ TableName: tableName(), Key: userKey(userId), ConsistentRead: true }),
  );
  return (result.Item as User | undefined) ?? null;
}

/** GitHub id, not login: usernames can be changed and reused by someone else. */
export async function getUserByGithubId(githubId: string): Promise<User | null> {
  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk = :sk',
      ExpressionAttributeValues: { ':pk': `GITHUB#${githubId}`, ':sk': 'USER' },
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as User | undefined) ?? null;
}

export async function putUser(user: User): Promise<User> {
  await documentClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        ...userKey(user.userId),
        // Indexed by GitHub id ONLY.
        //
        // An earlier version also spread email keys here "for support lookups".
        // Both write gsi1pk, and the email spread came second — so for any user
        // with a public email on GitHub, which is most of them, the GitHub index
        // key was silently overwritten and the login lookup found nothing. One
        // GSI holds one key pair per item; indexing by two things needs two
        // indexes.
        //
        // Email lookup was speculative and is used by nothing, so it is gone
        // rather than given an index of its own.
        gsi1pk: `GITHUB#${user.githubId}`,
        gsi1sk: 'USER',
        entity: 'User',
        ...user,
      },
    }),
  );
  return user;
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

export async function createSession(userId: string, token: string): Promise<Session> {
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SEC * 1000);

  const session: Session = {
    userId,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    ttlEpoch: Math.floor(expires.getTime() / 1000),
  };

  await documentClient().send(
    new PutCommand({
      TableName: tableName(),
      // Keyed by the HASH. The token itself is never written anywhere.
      Item: { ...sessionKey(hashToken(token)), entity: 'Session', ...session },
    }),
  );

  return session;
}

/**
 * Resolve a session token to its owner, or null.
 *
 * Checks expiry in code as well as relying on DynamoDB's TTL, because TTL
 * deletion is best-effort and can lag by hours. Treating an expired row as
 * valid because the sweeper has not reached it yet would be a real hole.
 */
export async function getSession(token: string): Promise<Session | null> {
  const result = await documentClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: sessionKey(hashToken(token)),
      ConsistentRead: true,
    }),
  );

  const session = result.Item as Session | undefined;
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

  return session;
}

export async function deleteSession(token: string): Promise<void> {
  await documentClient().send(
    new DeleteCommand({ TableName: tableName(), Key: sessionKey(hashToken(token)) }),
  );
}

/* ------------------------------------------------------------------ *
 * Daily deployment quota
 * ------------------------------------------------------------------ */

/**
 * A per-user, per-day counter with a conditional increment.
 *
 * O(1) rather than counting deployments, and atomic: the condition and the
 * increment happen in one write, so two simultaneous requests cannot both see
 * "49 used" and both proceed.
 *
 * This is a spend bound, not a product rule. Every deployment starts a Fargate
 * task, so an unbounded count is an unbounded bill (threat T8).
 */
export async function consumeDailyQuota(userId: string, limit: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  // Two days, so a counter written just before midnight is not read after it
  // has been swept away.
  const ttl = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;

  try {
    await documentClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `USER#${userId}`, SK: `QUOTA#${day}` },
        UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, ttlEpoch = :ttl, entity = :entity',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':limit': limit,
          ':ttl': ttl,
          ':entity': 'Quota',
        },
      }),
    );
    return true;
  } catch (e) {
    if (isConditionalCheckFailure(e)) return false;
    throw e;
  }
}
