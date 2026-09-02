import {
  generateProjectId,
  type Project,
} from '@platform/core';
import { authorizeProject, identify } from '../http/auth.js';
import { conflict, notFound, quotaExceeded } from '../http/errors.js';
import { json, parseBody, type HttpRequest, type HttpResponse } from '../http/response.js';
import { countProjects, createProject, listProjects } from '@platform/data';
import { createProjectSchema, parseRepositoryUrl } from '../validation/schemas.js';
import { projectUrl } from './actions.js';
import { isConditionalCheckFailure } from '@platform/data';

const MAX_PROJECTS_PER_USER = 10;

/** Public shape. Internal keys and schema version never leave the service. */
function present(project: Project): Record<string, unknown> {
  return {
    projectId: project.projectId,
    name: project.name,
    repositoryUrl: project.repositoryUrl,
    owner: project.owner,
    repo: project.repo,
    defaultBranch: project.defaultBranch,
    activeDeploymentId: project.activeDeploymentId,
    url: project.activeDeploymentId ? projectUrl(project.projectId) : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function handleCreateProject(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const body = parseBody(req, createProjectSchema);

  // Throws RepositoryUrlError, which the router maps to 400. Parsed here rather
  // than in the schema so the caller gets a specific reason, not "invalid url".
  const repository = parseRepositoryUrl(body.repositoryUrl);

  // A bound rather than a business rule: an unbounded project count is an
  // unbounded way to generate build capacity.
  if ((await countProjects(caller.userId)) >= MAX_PROJECTS_PER_USER) {
    throw quotaExceeded(`a user may have at most ${MAX_PROJECTS_PER_USER} projects`);
  }

  const now = new Date().toISOString();
  const project = await createProject({
    projectId: generateProjectId(),
    userId: caller.userId,
    name: body.name,
    repositoryUrl: repository.repositoryUrl,
    owner: repository.owner,
    repo: repository.repo,
    defaultBranch: body.defaultBranch,
    activeDeploymentId: null,
    createdAt: now,
    updatedAt: now,
  });

  return json(201, present(project));
}

export async function handleListProjects(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const projects = await listProjects(caller.userId);
  return json(200, { projects: projects.map(present) });
}

export async function handleGetProject(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const projectId = req.pathParameters['projectId'];
  if (!projectId) throw notFound('project');

  const project = await authorizeProject(caller, projectId);
  return json(200, present(project));
}

/** Surfaced by the router when a duplicate write loses its condition. */
export function asConflict(e: unknown): never {
  if (isConditionalCheckFailure(e)) throw conflict('resource already exists');
  throw e;
}
