/**
 * Single-table key construction.
 *
 * Every key in the system is built here. Nothing else concatenates a `#` by
 * hand — one typo in a handler would silently write an item that no query can
 * ever find again, and that is a bug you discover months later.
 *
 * Layout and rationale: docs/02-data-model.md, ADR-0008.
 */

import type { DeploymentStatus } from './deployment.js';
import { isTerminal } from './deployment.js';

export interface TableKey {
  PK: string;
  SK: string;
}

export interface GsiKeys {
  gsi1pk?: string;
  gsi1sk?: string;
  gsi2pk?: string;
  gsi2sk?: string;
}

export const GSI1 = 'gsi1' as const;
export const GSI2 = 'gsi2' as const;

/** Marks the sparse in-flight index. Only live deployments carry it. */
export const INFLIGHT = 'INFLIGHT' as const;

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const userKey = (userId: string): TableKey => ({
  PK: `USER#${userId}`,
  SK: 'PROFILE',
});

export const userByEmailKeys = (email: string): GsiKeys => ({
  gsi1pk: `EMAIL#${email.trim().toLowerCase()}`,
  gsi1sk: 'USER',
});

/* ------------------------------------------------------------------ *
 * Projects — stored under their owner so listing is one Query
 * ------------------------------------------------------------------ */

export const projectKey = (userId: string, projectId: string): TableKey => ({
  PK: `USER#${userId}`,
  SK: `PROJECT#${projectId}`,
});

export const projectByIdKeys = (projectId: string): GsiKeys => ({
  gsi1pk: `PROJECT#${projectId}`,
  gsi1sk: 'META',
});

/** Query(PK = USER#x, SK begins_with PROJECT#) lists a user's projects. */
export const projectListPrefix = (userId: string) => ({
  PK: `USER#${userId}`,
  skPrefix: 'PROJECT#',
});

/* ------------------------------------------------------------------ *
 * Deployments — stored under their project, sorted by time
 * ------------------------------------------------------------------ */

/**
 * The timestamp sits in the sort key so a Query with ScanIndexForward: false
 * returns newest-first with no sorting, no filtering and no extra index. The
 * id suffix breaks ties within the same millisecond.
 */
export const deploymentKey = (
  projectId: string,
  createdAt: string,
  deploymentId: string,
): TableKey => ({
  PK: `PROJECT#${projectId}`,
  SK: `DEP#${createdAt}#${deploymentId}`,
});

export const deploymentByIdKeys = (deploymentId: string): GsiKeys => ({
  gsi1pk: `DEP#${deploymentId}`,
  gsi1sk: 'META',
});

export const deploymentListPrefix = (projectId: string) => ({
  PK: `PROJECT#${projectId}`,
  skPrefix: 'DEP#',
});

/**
 * Sparse in-flight index.
 *
 * Present only while a deployment is live, and REMOVEd on every terminal
 * transition. That keeps the index to a handful of items, so the sweeper's
 * query costs what the number of *stuck* deployments costs — not what the whole
 * deployment history costs. Forgetting the REMOVE in one code path leaks an
 * item in here forever; `inFlightKeys` returning undefined for terminal states
 * is what makes that hard to get wrong.
 */
export function inFlightKeys(status: DeploymentStatus, deadlineAt: string): GsiKeys {
  if (isTerminal(status)) return {};
  return { gsi2pk: INFLIGHT, gsi2sk: deadlineAt };
}

/** Attribute names to strip when a deployment reaches a terminal state. */
export const INFLIGHT_ATTRIBUTES = ['gsi2pk', 'gsi2sk'] as const;

/* ------------------------------------------------------------------ *
 * Domains — the active-deployment pointer, source of truth for the edge
 * ------------------------------------------------------------------ */

export const domainKey = (hostname: string): TableKey => ({
  PK: `DOMAIN#${hostname.trim().toLowerCase()}`,
  SK: 'META',
});

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export const sessionKey = (tokenHash: string): TableKey => ({
  PK: `SESSION#${tokenHash}`,
  SK: 'META',
});

/* ------------------------------------------------------------------ *
 * Pagination cursors
 * ------------------------------------------------------------------ */

/**
 * A cursor is a DynamoDB LastEvaluatedKey, which is a raw table key. Handing it
 * to a client unsigned would let anyone edit it and query into another user's
 * partition, so it is signed before it leaves and verified on the way back.
 * The signing itself lives in the API package, where the secret is.
 */
export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('cursor is not an object');
  }
  return parsed as Record<string, unknown>;
}
