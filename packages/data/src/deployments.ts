/**
 * Deployment persistence.
 *
 * The two functions that matter are `claim` and `transition`. Both build a
 * ConditionExpression from the state machine in @platform/core, so the database
 * refuses an illegal move even if a caller forgets to check first. That is the
 * whole idempotency story: DynamoDB decides who wins, not application code.
 *
 * See docs/02-data-model.md and ADR-0008.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  INFLIGHT,
  allowedPredecessors,
  assertTransition,
  computeDeadline,
  decodeCursor,
  deploymentByIdKeys,
  deploymentKey,
  deploymentListPrefix,
  encodeCursor,
  inFlightKeys,
  isTerminal,
  SCHEMA_VERSION,
  type Actor,
  type Deployment,
  type DeploymentError,
  type DeploymentStatus,
} from '@platform/core';
import { documentClient, isConditionalCheckFailure, tableName } from './table.js';

export interface CreateDeploymentInput {
  deployment: Omit<Deployment, 'schemaVersion' | 'deadlineAt'> & { deadlineAt?: string };
  buildTimeoutSec: number;
}

/** Attributes that are keys or otherwise never patched by a transition. */
const RESERVED = new Set(['PK', 'SK', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'entity']);

export async function createDeployment(input: CreateDeploymentInput): Promise<Deployment> {
  const { deployment, buildTimeoutSec } = input;
  const deadlineAt = deployment.deadlineAt ?? computeDeadline(deployment.createdAt, buildTimeoutSec);

  const record: Deployment = { ...deployment, deadlineAt, schemaVersion: SCHEMA_VERSION };

  const item = {
    ...deploymentKey(record.projectId, record.createdAt, record.deploymentId),
    ...deploymentByIdKeys(record.deploymentId),
    ...inFlightKeys(record.status, deadlineAt),
    entity: 'Deployment',
    ...record,
  };

  await documentClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: item,
      // Guards against a retry writing the same deployment twice.
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return record;
}

export async function getDeploymentById(deploymentId: string): Promise<Deployment | null> {
  const { gsi1pk, gsi1sk } = deploymentByIdKeys(deploymentId);

  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk = :sk',
      ExpressionAttributeValues: { ':pk': gsi1pk, ':sk': gsi1sk },
      Limit: 1,
    }),
  );

  const item = result.Items?.[0];
  return item ? (item as Deployment) : null;
}

/**
 * A consistent read of the base item. Authorization and any read-then-write
 * must use this: GSI reads are ALWAYS eventually consistent, and acting on a
 * stale one here is a security bug, not a performance detail.
 */
export async function getDeploymentConsistent(
  projectId: string,
  createdAt: string,
  deploymentId: string,
): Promise<Deployment | null> {
  const result = await documentClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: deploymentKey(projectId, createdAt, deploymentId),
      ConsistentRead: true,
    }),
  );
  return result.Item ? (result.Item as Deployment) : null;
}

export interface ListDeploymentsResult {
  deployments: Deployment[];
  nextCursor: string | null;
}

export async function listDeployments(
  projectId: string,
  limit = 20,
  cursor?: string,
): Promise<ListDeploymentsResult> {
  const { PK, skPrefix } = deploymentListPrefix(projectId);

  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': PK, ':sk': skPrefix },
      // The timestamp lives in the sort key, so descending order is
      // newest-first with no sorting and no extra index.
      ScanIndexForward: false,
      Limit: Math.min(Math.max(limit, 1), 100),
      ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor) } : {}),
    }),
  );

  return {
    deployments: (result.Items ?? []) as Deployment[],
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
  };
}

export interface TransitionInput {
  deployment: Pick<Deployment, 'projectId' | 'createdAt' | 'deploymentId' | 'deadlineAt'>;
  to: DeploymentStatus;
  by: Actor;
  /** Extra attributes to set alongside the status change. */
  patch?: Partial<Deployment>;
}

export interface TransitionResult {
  won: boolean;
  deployment: Deployment | null;
}

/**
 * Move a deployment to a new status, or lose the race.
 *
 * `won: false` is a normal outcome, not an error — it means another worker got
 * there first, and the caller should exit quietly rather than retry.
 */
export async function transition(input: TransitionInput): Promise<TransitionResult> {
  const { deployment, to, by, patch = {} } = input;

  const from = allowedPredecessors(to, by);
  if (from.length === 0) {
    // No legal path at all: a programming error, not a race.
    assertTransition('DEPLOYED', to, by);
    throw new Error(`no actor "${by}" can move a deployment to ${to}`);
  }

  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = { ':to': to };
  const sets = ['#status = :to'];

  for (const [key, value] of Object.entries(patch)) {
    if (RESERVED.has(key) || key === 'status' || value === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  // Terminal states leave the sparse in-flight index. Missing this in one code
  // path leaks the item there forever and the sweeper reprocesses it endlessly.
  const removes = isTerminal(to) ? ['gsi2pk', 'gsi2sk'] : [];
  const stayingInFlight = !isTerminal(to);
  if (stayingInFlight) {
    names['#gsi2pk'] = 'gsi2pk';
    names['#gsi2sk'] = 'gsi2sk';
    values[':inflight'] = INFLIGHT;
    values[':deadline'] = deployment.deadlineAt;
    sets.push('#gsi2pk = :inflight', '#gsi2sk = :deadline');
  }

  const fromPlaceholders = from.map((status, i) => {
    values[`:from${i}`] = status;
    return `:from${i}`;
  });

  let expression = `SET ${sets.join(', ')}`;
  if (removes.length > 0) expression += ` REMOVE ${removes.join(', ')}`;

  try {
    const result = await documentClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: deploymentKey(deployment.projectId, deployment.createdAt, deployment.deploymentId),
        UpdateExpression: expression,
        ConditionExpression: `#status IN (${fromPlaceholders.join(', ')})`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return { won: true, deployment: (result.Attributes ?? null) as Deployment | null };
  } catch (e) {
    if (isConditionalCheckFailure(e)) return { won: false, deployment: null };
    throw e;
  }
}

/**
 * Update attributes WITHOUT changing status.
 *
 * Distinct from `transition` on purpose. Recording a task ARN on a deployment
 * that is already PROVISIONING is not a state change, and routing it through
 * `transition` would ask for PROVISIONING -> PROVISIONING — which the state
 * machine correctly refuses, since a self-transition is never legal.
 *
 * Still guarded: the optional status list keeps a late patch from resurrecting
 * a deployment that has already finished or failed.
 */
export async function patchDeployment(
  deployment: Pick<Deployment, 'projectId' | 'createdAt' | 'deploymentId'>,
  patch: Partial<Deployment>,
  expectStatus?: DeploymentStatus[],
): Promise<boolean> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (RESERVED.has(key) || key === 'status' || value === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  if (sets.length === 0) return true;

  let condition = 'attribute_exists(PK)';
  if (expectStatus && expectStatus.length > 0) {
    names['#status'] = 'status';
    const placeholders = expectStatus.map((status, i) => {
      values[`:expect${i}`] = status;
      return `:expect${i}`;
    });
    condition = `#status IN (${placeholders.join(', ')})`;
  }

  try {
    await documentClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: deploymentKey(deployment.projectId, deployment.createdAt, deployment.deploymentId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (e) {
    if (isConditionalCheckFailure(e)) return false;
    throw e;
  }
}

/**
 * The claim: QUEUED -> PROVISIONING.
 *
 * Exactly one dispatcher can win this, which is what makes the pipeline
 * idempotent under SQS's at-least-once delivery. A duplicate message loses the
 * condition, deletes itself, and launches nothing.
 */
export function claimDeployment(
  deployment: Pick<Deployment, 'projectId' | 'createdAt' | 'deploymentId' | 'deadlineAt'>,
  patch: Partial<Deployment> = {},
): Promise<TransitionResult> {
  return transition({
    deployment,
    to: 'PROVISIONING',
    by: 'dispatcher',
    patch: { startedAt: new Date().toISOString(), ...patch },
  });
}

export function failDeployment(
  deployment: Pick<Deployment, 'projectId' | 'createdAt' | 'deploymentId' | 'deadlineAt'>,
  by: Actor,
  error: DeploymentError,
): Promise<TransitionResult> {
  return transition({
    deployment,
    to: 'FAILED',
    by,
    patch: { error, finishedAt: new Date().toISOString() },
  });
}

/** Deployments past their deadline. Reads the sparse index, so it is cheap. */
export async function findOverdueDeployments(now = new Date()): Promise<
  Pick<Deployment, 'projectId' | 'createdAt' | 'deploymentId' | 'deadlineAt' | 'status'>[]
> {
  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :pk AND gsi2sk < :now',
      ExpressionAttributeValues: { ':pk': INFLIGHT, ':now': now.toISOString() },
    }),
  );

  return (result.Items ?? []) as Pick<
    Deployment,
    'projectId' | 'createdAt' | 'deploymentId' | 'deadlineAt' | 'status'
  >[];
}
