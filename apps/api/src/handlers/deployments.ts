import { type Deployment } from '@platform/core';
import { authorizeProject, identify } from '../http/auth.js';
import { notFound } from '../http/errors.js';
import { json, parseBody, type HttpRequest, type HttpResponse } from '../http/response.js';
import { getDeploymentById, listDeployments } from '@platform/data';
import { startDeployment } from '../deploy.js';
import { createDeploymentSchema, listQuerySchema } from '../validation/schemas.js';

function deploymentUrl(deployment: Deployment): string | null {
  const domain = process.env['DEPLOYMENT_DOMAIN'];
  if (domain) return `https://${deployment.hostname}/`;

  // Without a custom domain, deployments are reachable through CloudFront's
  // own domain in path mode. See infra/stacks/edge/router.js.
  const cdn = process.env['CLOUDFRONT_DOMAIN'];
  return cdn ? `https://${cdn}/d/${deployment.deploymentId}/` : null;
}

function present(deployment: Deployment): Record<string, unknown> {
  return {
    deploymentId: deployment.deploymentId,
    projectId: deployment.projectId,
    status: deployment.status,
    branch: deployment.branch,
    commitSha: deployment.commitSha,
    commitMessage: deployment.commitMessage,
    trigger: deployment.trigger,
    framework: deployment.framework,
    url: deploymentUrl(deployment),
    createdAt: deployment.createdAt,
    startedAt: deployment.startedAt,
    finishedAt: deployment.finishedAt,
    durationMs: deployment.durationMs,
    artifactBytes: deployment.artifactBytes,
    fileCount: deployment.fileCount,
    error: deployment.error,
    // Deliberately absent: artifactPrefix, taskArn, statusTokenHash, deadlineAt.
    // Internal plumbing that clients have no use for and attackers do.
  };
}

export async function handleCreateDeployment(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const projectId = req.pathParameters['projectId'];
  if (!projectId) throw notFound('project');

  const project = await authorizeProject(caller, projectId);
  const body = parseBody(req, createDeploymentSchema);

  // One shared path for every trigger — see apps/api/src/deploy.ts. It consumes
  // the daily quota, writes the QUEUED record, and enqueues.
  const deployment = await startDeployment(project, {
    branch: body.branch ?? project.defaultBranch,
    commitSha: body.commitSha ?? null,
    trigger: 'manual',
  });

  // 202, not 201: the record exists, but the work has not happened. The API must
  // not wait for a build that takes minutes.
  return json(202, present(deployment));
}

export async function handleGetDeployment(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const deploymentId = req.pathParameters['deploymentId'];
  if (!deploymentId) throw notFound('deployment');

  const deployment = await getDeploymentById(deploymentId);

  // One check, one outcome: not yours and not there look identical from
  // outside, so this cannot be used to discover which ids exist.
  if (!deployment || deployment.userId !== caller.userId) throw notFound('deployment');

  return json(200, present(deployment));
}

export async function handleListDeployments(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const projectId = req.pathParameters['projectId'];
  if (!projectId) throw notFound('project');

  await authorizeProject(caller, projectId);
  const query = listQuerySchema.parse(req.query);

  const result = await listDeployments(projectId, query.limit, query.cursor);
  return json(200, {
    deployments: result.deployments.map(present),
    nextCursor: result.nextCursor,
  });
}
