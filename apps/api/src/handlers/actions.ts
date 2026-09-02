/**
 * Promote, retry, cancel.
 *
 * All three were specified in docs/03-api.md and none existed. Promote matters
 * most: "rollback is a pointer swap, never a rebuild" is one of the five ideas
 * this project is built to demonstrate, and until now it was only a claim.
 */

import { isTerminal, type Deployment } from '@platform/core';
import { getDeploymentById, setActiveDeployment, transition } from '@platform/data';
import { putRoute } from '../edge.js';
import { startDeployment } from '../deploy.js';
import { authorizeProject, identify } from '../http/auth.js';
import { conflict, notFound } from '../http/errors.js';
import { json, type HttpRequest, type HttpResponse } from '../http/response.js';

/**
 * The stable, project-level routing key.
 *
 * Each deployment also keeps its own immutable URL forever; this is the one that
 * moves. Rollback writes a different prefix to this same key — which is the
 * whole point: the artifacts never change, only what this points at.
 */
export function projectRouteKey(projectId: string): string {
  return `p_${projectId}`;
}

async function loadOwned(req: HttpRequest): Promise<Deployment> {
  const caller = await identify(req);
  const deploymentId = req.pathParameters['deploymentId'];
  if (!deploymentId) throw notFound('deployment');

  const deployment = await getDeploymentById(deploymentId);
  // Same 404 for absent and not-yours, so this cannot enumerate ids.
  if (!deployment || deployment.userId !== caller.userId) throw notFound('deployment');

  return deployment;
}

/**
 * Point a project's URL at a deployment that already exists.
 *
 * No build, no container, no queue — one write to the edge routing table and
 * one to the project record. That is only possible because artifacts are
 * immutable and live at a prefix unique to their deployment: the old bytes are
 * still exactly where they were, so "rolling back" is just addressing them
 * again. It is also why no cache invalidation is needed — the prefix changed,
 * so the cache keys changed.
 */
export async function handlePromote(req: HttpRequest): Promise<HttpResponse> {
  const deployment = await loadOwned(req);

  if (deployment.status !== 'DEPLOYED') {
    throw conflict(
      `only a deployed build can be promoted; this one is ${deployment.status.toLowerCase()}`,
    );
  }

  const started = Date.now();

  await putRoute({ key: projectRouteKey(deployment.projectId), prefix: deployment.artifactPrefix });
  if (deployment.hostname) {
    await putRoute({ key: deployment.hostname, prefix: deployment.artifactPrefix });
  }
  await setActiveDeployment(deployment.userId, deployment.projectId, deployment.deploymentId);

  return json(200, {
    promoted: deployment.deploymentId,
    projectId: deployment.projectId,
    url: projectUrl(deployment.projectId),
    // Reported because it is the point: this is milliseconds, where a rebuild
    // would be minutes.
    tookMs: Date.now() - started,
    rebuilt: false,
  });
}

/**
 * Retry as a NEW deployment rather than reusing the old record.
 *
 * The failed attempt stays visible in history, which is both better UX and the
 * reason automatic retry is not implemented: a failing build usually fails
 * deterministically, so retrying should be a decision someone makes.
 */
export async function handleRetry(req: HttpRequest): Promise<HttpResponse> {
  const original = await loadOwned(req);
  const caller = await identify(req);
  const project = await authorizeProject(caller, original.projectId);

  if (!isTerminal(original.status)) {
    throw conflict('that deployment is still running');
  }

  // Same shared path as a manual deploy. The ref is the ORIGINAL's — a retry
  // means "try that again", not "build whatever is on the branch now".
  const deployment = await startDeployment(project, {
    branch: original.branch,
    commitSha: original.commitSha,
    commitMessage: original.commitMessage,
    trigger: 'retry',
    retryOfDeploymentId: original.deploymentId,
  });

  return json(202, { deploymentId: deployment.deploymentId, status: deployment.status });
}

/**
 * Cancel, but only before a container exists.
 *
 * Once a build is running there is nothing useful to cancel — it will finish or
 * hit its timeout within minutes, and stopping the task midway would leave a
 * half-uploaded prefix. The state machine encodes this: CANCELLED is reachable
 * only from QUEUED and PROVISIONING.
 */
export async function handleCancel(req: HttpRequest): Promise<HttpResponse> {
  const deployment = await loadOwned(req);

  const result = await transition({
    deployment,
    to: 'CANCELLED',
    by: 'api',
    patch: { finishedAt: new Date().toISOString() },
  });

  if (!result.won) {
    throw conflict(
      `a deployment can only be cancelled before it starts building; this one is ${deployment.status.toLowerCase()}`,
    );
  }

  return json(200, { deploymentId: deployment.deploymentId, status: 'CANCELLED' });
}

export function projectUrl(projectId: string): string | null {
  const cdn = process.env['CLOUDFRONT_DOMAIN'];
  return cdn ? `https://${cdn}/d/${projectRouteKey(projectId)}/` : null;
}
