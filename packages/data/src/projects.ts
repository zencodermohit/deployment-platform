/**
 * Project persistence.
 *
 * Projects are stored under their owner (`PK = USER#<id>`), so listing a user's
 * projects is one Query, and GSI1 provides lookup by project id alone for the
 * routes that only carry one.
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SCHEMA_VERSION,
  projectByIdKeys,
  projectKey,
  projectListPrefix,
  type Project,
} from '@platform/core';
import { documentClient, tableName } from './table.js';

export async function createProject(project: Omit<Project, 'schemaVersion'>): Promise<Project> {
  const record: Project = { ...project, schemaVersion: SCHEMA_VERSION };

  await documentClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        ...projectKey(record.userId, record.projectId),
        ...projectByIdKeys(record.projectId),
        entity: 'Project',
        ...record,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return record;
}

/**
 * Lookup by project id alone, for routes that do not carry the owner.
 *
 * Reads GSI1, which is ALWAYS eventually consistent — DynamoDB offers no
 * choice. The caller must therefore treat the result as "which user owns this"
 * and, for anything that writes, re-read the base item consistently.
 */
export async function getProjectById(projectId: string): Promise<Project | null> {
  const { gsi1pk, gsi1sk } = projectByIdKeys(projectId);

  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk = :sk',
      ExpressionAttributeValues: { ':pk': gsi1pk, ':sk': gsi1sk },
      Limit: 1,
    }),
  );

  return (result.Items?.[0] as Project | undefined) ?? null;
}

/**
 * The authorization read.
 *
 * Strongly consistent and scoped to the owner's partition, so it answers
 * "does this project belong to this user" without trusting an index that may
 * be stale. A stale read here is a security bug, not a performance detail.
 */
export async function getProjectForUser(
  userId: string,
  projectId: string,
): Promise<Project | null> {
  const result = await documentClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: projectKey(userId, projectId),
      ConsistentRead: true,
    }),
  );
  return (result.Item as Project | undefined) ?? null;
}

export async function listProjects(userId: string, limit = 50): Promise<Project[]> {
  const { PK, skPrefix } = projectListPrefix(userId);

  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': PK, ':sk': skPrefix },
      Limit: Math.min(Math.max(limit, 1), 100),
    }),
  );

  return (result.Items ?? []) as Project[];
}

export async function countProjects(userId: string): Promise<number> {
  const { PK, skPrefix } = projectListPrefix(userId);

  const result = await documentClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': PK, ':sk': skPrefix },
      Select: 'COUNT',
    }),
  );

  return result.Count ?? 0;
}

/** Store (or rotate) the project's webhook secret. Never returned by any read. */
export async function setWebhookSecret(
  userId: string,
  projectId: string,
  secret: string,
): Promise<void> {
  await documentClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: projectKey(userId, projectId),
      UpdateExpression: 'SET webhookSecret = :s, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':s': secret, ':now': new Date().toISOString() },
    }),
  );
}

/** Records which deployment a project currently serves. Used by promote/rollback. */
export async function setActiveDeployment(
  userId: string,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await documentClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: projectKey(userId, projectId),
      UpdateExpression: 'SET activeDeploymentId = :d, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':d': deploymentId, ':now': new Date().toISOString() },
    }),
  );
}
