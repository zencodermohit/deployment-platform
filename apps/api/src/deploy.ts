/**
 * Starting a deployment — the one path every trigger goes through.
 *
 * Manual (`POST /deployments`), retry, and webhook all end here. Three copies of
 * this logic is exactly the drift that lets a webhook build skip the quota, or a
 * retry write a subtly different record — so there is one copy, and the callers
 * differ only in what they pass in.
 */

import {
  artifactPrefix,
  deploymentHostname,
  generateDeploymentId,
  type Deployment,
  type DeploymentTrigger,
  type Project,
} from '@platform/core';
import { consumeDailyQuota, createDeployment } from '@platform/data';
import { enqueueDeployment } from './queue.js';
import { quotaExceeded } from './http/errors.js';

const BUILD_TIMEOUT_SEC = Number(process.env['BUILD_TIMEOUT_SEC'] ?? 600);
const MAX_DEPLOYMENTS_PER_DAY = Number(process.env['MAX_DEPLOYMENTS_PER_DAY'] ?? 50);

export interface StartOptions {
  branch: string;
  commitSha?: string | null;
  commitMessage?: string | null;
  trigger: DeploymentTrigger;
  retryOfDeploymentId?: string | null;
}

/**
 * Create a QUEUED deployment for a project and enqueue it.
 *
 * The quota is consumed FIRST, so a rejected request leaves no record behind,
 * and it is charged to the project's OWNER — a webhook has no caller of its own,
 * and the person whose project it is should bear its spend either way.
 */
export async function startDeployment(
  project: Project,
  options: StartOptions,
): Promise<Deployment> {
  if (!(await consumeDailyQuota(project.userId, MAX_DEPLOYMENTS_PER_DAY))) {
    throw quotaExceeded(
      `this project's owner has reached the limit of ${MAX_DEPLOYMENTS_PER_DAY} deployments per day`,
    );
  }

  const deploymentId = generateDeploymentId();
  const domain = process.env['DEPLOYMENT_DOMAIN'] ?? '';
  const now = new Date().toISOString();

  const deployment = await createDeployment({
    buildTimeoutSec: BUILD_TIMEOUT_SEC,
    deployment: {
      deploymentId,
      projectId: project.projectId,
      userId: project.userId,
      status: 'QUEUED',

      // Always read from the project, never from the request. Accepting a
      // repository URL from a caller would let them point a project at any repo.
      repositoryUrl: project.repositoryUrl,
      owner: project.owner,
      repo: project.repo,

      branch: options.branch,
      commitSha: options.commitSha ?? null,
      commitMessage: options.commitMessage ?? null,
      trigger: options.trigger,

      framework: null,
      // Both derived on the server from ids alone (threats T4, T6).
      artifactPrefix: artifactPrefix(project.projectId, deploymentId),
      hostname: domain ? deploymentHostname(deploymentId, domain) : '',

      taskArn: null,
      logStreamName: `builds/${deploymentId}`,
      statusTokenHash: null,

      createdAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      artifactBytes: null,
      fileCount: null,
      error: null,
      retryOfDeploymentId: options.retryOfDeploymentId ?? null,
    },
  });

  // Enqueue AFTER the record exists, so a dispatcher that picks the message up
  // instantly still finds a row to claim. If this throws, the deployment stays
  // QUEUED and the sweeper fails it at its deadline rather than leaving it
  // forever.
  await enqueueDeployment(deployment.deploymentId);

  return deployment;
}
