import {
  artifactPrefix,
  deploymentHostname,
  generateDeploymentId,
  type Deployment,
} from '@platform/core';
import { authorizeProject, identify } from '../http/auth.js';
import { notFound } from '../http/errors.js';
import { json, parseBody, type HttpRequest, type HttpResponse } from '../http/response.js';
import { createDeployment, getDeploymentById, listDeployments } from '../repository/deployments.js';
import { createDeploymentSchema, listQuerySchema } from '../validation/schemas.js';

const BUILD_TIMEOUT_SEC = Number(process.env['BUILD_TIMEOUT_SEC'] ?? 600);

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
  const caller = identify(req);
  const projectId = req.pathParameters['projectId'];
  if (!projectId) throw notFound('project');

  const project = await authorizeProject(caller, projectId);
  const body = parseBody(req, createDeploymentSchema);

  const deploymentId = generateDeploymentId();
  const domain = process.env['DEPLOYMENT_DOMAIN'] ?? '';
  const now = new Date().toISOString();

  const deployment = await createDeployment({
    buildTimeoutSec: BUILD_TIMEOUT_SEC,
    deployment: {
      deploymentId,
      projectId: project.projectId,
      userId: caller.userId,
      status: 'QUEUED',

      // Read from the project, never from the request. Accepting a repository
      // URL here would let a caller point an existing project at any repo.
      repositoryUrl: project.repositoryUrl,
      owner: project.owner,
      repo: project.repo,

      branch: body.branch ?? project.defaultBranch,
      // M4 resolves the branch head to an immutable SHA through the GitHub App
      // before the build is dispatched. Until then it stays null unless given.
      commitSha: body.commitSha ?? null,
      commitMessage: null,
      trigger: 'manual',

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
      retryOfDeploymentId: null,
    },
  });

  // 202, not 201: the deployment record exists, but the work has not happened.
  // The API must not wait for a build that takes minutes.
  return json(202, present(deployment));
}

export async function handleGetDeployment(req: HttpRequest): Promise<HttpResponse> {
  const caller = identify(req);
  const deploymentId = req.pathParameters['deploymentId'];
  if (!deploymentId) throw notFound('deployment');

  const deployment = await getDeploymentById(deploymentId);

  // One check, one outcome: not yours and not there look identical from
  // outside, so this cannot be used to discover which ids exist.
  if (!deployment || deployment.userId !== caller.userId) throw notFound('deployment');

  return json(200, present(deployment));
}

export async function handleListDeployments(req: HttpRequest): Promise<HttpResponse> {
  const caller = identify(req);
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
