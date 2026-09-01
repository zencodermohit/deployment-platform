/**
 * Dispatcher — SQS-triggered. The piece the original design left as an empty
 * box labelled "Build Orchestrator".
 *
 * Order matters here, and this is the ordering rationale:
 *
 *   1. CLAIM FIRST. The QUEUED -> PROVISIONING conditional write is what makes
 *      the pipeline idempotent under SQS's at-least-once delivery. Claiming
 *      before doing any work means a duplicate message does no work at all.
 *      Claiming after launching would be too late: two containers would already
 *      be running.
 *
 *   2. Fetch the source on this side of the trust boundary (ADR-0004).
 *
 *   3. RunTask, then return. Never wait — a build takes minutes and Lambda is
 *      billed by the millisecond.
 *
 * Because the message is deleted as soon as RunTask succeeds, SQS retries cover
 * DISPATCH failures only. Build failures are terminal and recovered by the
 * reconciler or the sweeper. See docs/01-architecture.md §4.
 */

import { createHash, randomBytes } from 'node:crypto';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import {
  claimDeployment,
  failDeployment,
  getDeploymentById,
  patchDeployment,
} from '@platform/data';
import { fetchSourceToS3, presignSource, SourceError } from './source.js';
import { env, log } from './shared.js';

const ecs = new ECSClient({});

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

export async function handler(event: SqsEvent): Promise<void> {
  for (const record of event.Records ?? []) {
    await dispatchOne(record);
  }
}

async function dispatchOne(record: SqsRecord): Promise<void> {
  let deploymentId: string;
  try {
    deploymentId = String((JSON.parse(record.body) as { deploymentId?: unknown }).deploymentId);
  } catch {
    // A malformed message will never become valid. Swallow it so it goes to the
    // DLQ by way of being deleted, rather than poisoning the queue forever.
    log('error', 'unparseable message', { messageId: record.messageId });
    return;
  }

  const deployment = await getDeploymentById(deploymentId);
  if (!deployment) {
    log('warn', 'deployment not found; nothing to dispatch', { deploymentId });
    return;
  }

  // --- 1. Claim. Exactly one dispatcher gets past this line. ---
  const statusToken = `stk_${randomBytes(32).toString('hex')}`;
  const statusTokenHash = createHash('sha256').update(statusToken).digest('hex');

  const claim = await claimDeployment(deployment, { statusTokenHash });
  if (!claim.won) {
    log('info', 'another dispatcher owns this deployment; exiting', { deploymentId });
    return;
  }

  log('info', 'claimed', { deploymentId });

  try {
    // --- 2. Fetch the source on the trusted side. ---
    const sourceKey = `sources/${deploymentId}.tar.gz`;
    const fetched = await fetchSourceToS3({
      owner: deployment.owner,
      repo: deployment.repo,
      ref: deployment.commitSha ?? deployment.branch,
      bucket: env('SOURCES_BUCKET'),
      key: sourceKey,
      maxBytes: Number(env('MAX_ARCHIVE_BYTES', '104857600')),
    });

    const sourceUrl = await presignSource(env('SOURCES_BUCKET'), sourceKey);
    log('info', 'source staged', { deploymentId, bytes: fetched.bytes, commitSha: fetched.commitSha });

    // --- 3. Launch, then return. ---
    const task = await ecs.send(
      new RunTaskCommand({
        cluster: env('ECS_CLUSTER'),
        taskDefinition: env('TASK_DEFINITION'),
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: env('SUBNET_IDS').split(','),
            securityGroups: [env('SECURITY_GROUP_ID')],
            // A public IP, with a security group that has no inbound rules.
            // Nothing can reach in; the task needs egress for npm. ADR-0007.
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: 'builder',
              environment: [
                { name: 'BUILDER_MODE', value: 'aws' },
                { name: 'DEPLOYMENT_ID', value: deploymentId },
                { name: 'SOURCE_URL', value: sourceUrl },
                { name: 'ARTIFACT_BUCKET', value: env('ARTIFACTS_BUCKET') },
                { name: 'ARTIFACT_PREFIX', value: deployment.artifactPrefix },
                { name: 'STATUS_URL', value: `${env('API_URL')}/internal/deployments/${deploymentId}/status` },
                { name: 'STATUS_TOKEN', value: statusToken },
                { name: 'BUILD_TIMEOUT_SEC', value: env('BUILD_TIMEOUT_SEC', '600') },
              ],
            },
          ],
        },
        // Lets the reconciler tie an ECS event back to a deployment without a
        // lookup table.
        tags: [
          { key: 'deploymentId', value: deploymentId },
          { key: 'projectId', value: deployment.projectId },
        ],
        propagateTags: 'TASK_DEFINITION',
      }),
    );

    const failure = task.failures?.[0];
    if (failure) {
      throw new Error(`ECS refused to start the task: ${failure.reason ?? 'unknown'}`);
    }

    const taskArn = task.tasks?.[0]?.taskArn;
    log('info', 'task started', { deploymentId, taskArn });

    if (taskArn) {
      // A plain patch, not a transition: the deployment is already
      // PROVISIONING, and PROVISIONING -> PROVISIONING is not a legal move.
      // Guarded so a slow write cannot resurrect a deployment that has since
      // been failed by the sweeper.
      await patchDeployment(deployment, { taskArn }, ['PROVISIONING', 'BUILDING']);
    }
  } catch (e) {
    // We already own this deployment, so nothing else will report it. Fail it
    // here rather than leaving it stuck in PROVISIONING until the sweeper.
    const message = e instanceof Error ? e.message : String(e);
    log('error', 'dispatch failed', { deploymentId, reason: message });

    await failDeployment(deployment, 'dispatcher', {
      code: e instanceof SourceError ? 'SOURCE_ERROR' : 'DISPATCH_FAILED',
      message,
    });
  }
}
