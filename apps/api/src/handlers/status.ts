/**
 * POST /internal/deployments/{deploymentId}/status
 *
 * The build container's only way to report progress. It holds NO DynamoDB
 * permissions (ADR-0009), so this endpoint is the entire interface between the
 * untrusted build plane and the control plane's state.
 *
 * Authenticated with a per-deployment bearer token minted at dispatch, stored
 * only as a SHA-256 hash, and scoped to one deployment until its deadline. A
 * stolen token therefore lets an attacker forge status for a build they already
 * control, which is worth nothing.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  emitMetrics,
  isTerminal,
  METRICS,
  type Deployment,
  type DeploymentStatus,
} from '@platform/core';
import {
  getDeploymentById,
  setActiveDeployment,
  transition,
} from '@platform/data';
import { putRoute } from '../edge.js';
import { ApiError, notFound, unauthenticated } from '../http/errors.js';
import { json, parseBody, type HttpRequest, type HttpResponse } from '../http/response.js';
import { bearerToken } from '../http/auth.js';
import { statusCallbackSchema } from '../validation/schemas.js';

export async function handleStatusCallback(req: HttpRequest): Promise<HttpResponse> {
  const deploymentId = req.pathParameters['deploymentId'];
  if (!deploymentId) throw notFound('deployment');

  const presented = bearerToken(req);
  if (!presented) throw unauthenticated('a status token is required');

  const deployment = await getDeploymentById(deploymentId);
  // Same 404 whether the deployment is absent or the token is wrong: a
  // distinguishable response would let someone probe which ids exist.
  if (!deployment) throw notFound('deployment');

  assertToken(presented, deployment);

  const body = parseBody(req, statusCallbackSchema);
  const to = body.status as DeploymentStatus;

  const result = await transition({
    deployment,
    to,
    by: 'container',
    patch: {
      framework: body.framework ?? deployment.framework,
      artifactBytes: body.artifactBytes ?? deployment.artifactBytes,
      fileCount: body.fileCount ?? deployment.fileCount,
      error: body.error ?? null,
      ...(isTerminal(to)
        ? {
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - new Date(deployment.createdAt).getTime(),
          }
        : {}),
    },
  });

  // A lost race is not an error. The reconciler may have already failed this
  // deployment, in which case the container's late report is simply ignored.
  if (!result.won) {
    return json(200, { applied: false, reason: 'the deployment is no longer in that state' });
  }

  if (isTerminal(to)) {
    const durationMs = Date.now() - new Date(deployment.createdAt).getTime();
    emitMetrics({
      // Status only — a deployment id here would create a new CloudWatch metric
      // per deployment, which is how an observability bill runs away.
      dimensions: { Outcome: to },
      metrics: [
        { name: METRICS.deploymentOutcome, value: 1, unit: 'Count' },
        { name: METRICS.buildDuration, value: durationMs, unit: 'Milliseconds' },
        ...(body.artifactBytes
          ? [{ name: METRICS.artifactBytes, value: body.artifactBytes, unit: 'Bytes' as const }]
          : []),
        ...(body.fileCount
          ? [{ name: METRICS.artifactFiles, value: body.fileCount, unit: 'Count' as const }]
          : []),
      ],
      properties: {
        msg: 'deployment finished',
        deploymentId: deployment.deploymentId,
        framework: body.framework ?? deployment.framework,
        errorCode: body.error?.code ?? null,
      },
    });
  }

  if (to === 'DEPLOYED') {
    await publishRoute(deployment);
  }

  return json(200, { applied: true, status: to });
}

/**
 * Make the deployment reachable.
 *
 * Deliberately after the state transition and deliberately not fatal: the build
 * genuinely succeeded and the artifacts are in S3. If the edge write fails the
 * deployment is complete but unrouted, which is recoverable — and far better
 * than reporting a successful build as failed.
 */
async function publishRoute(deployment: Deployment): Promise<void> {
  try {
    await putRoute({
      // Path mode keys on the deployment id; with a custom domain the hostname
      // is the key. Both are written so either URL works.
      key: deployment.deploymentId,
      prefix: deployment.artifactPrefix,
    });

    if (deployment.hostname) {
      await putRoute({ key: deployment.hostname, prefix: deployment.artifactPrefix });
    }

    await setActiveDeployment(deployment.userId, deployment.projectId, deployment.deploymentId);
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'deployment succeeded but could not be routed',
        deploymentId: deployment.deploymentId,
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

function assertToken(presented: string, deployment: Deployment): void {
  if (!deployment.statusTokenHash) throw notFound('deployment');

  // Expire with the deployment's own deadline, so a token cannot outlive the
  // build it was minted for.
  if (Date.now() > new Date(deployment.deadlineAt).getTime()) {
    throw new ApiError('UNAUTHENTICATED', 'this status token has expired');
  }

  const presentedHash = createHash('sha256').update(presented).digest();
  const expectedHash = Buffer.from(deployment.statusTokenHash, 'hex');

  // Constant-time, so response timing cannot be used to recover the token a
  // byte at a time. Lengths must match first — timingSafeEqual throws otherwise.
  const ok =
    presentedHash.length === expectedHash.length && timingSafeEqual(presentedHash, expectedHash);

  if (!ok) throw notFound('deployment');
}
