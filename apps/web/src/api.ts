/**
 * Typed client for the control-plane API.
 *
 * Every response shape here is written by hand rather than shared with the
 * backend. That is deliberate: the API is a contract, and if the frontend
 * imported the handlers' own types they would agree by construction and a
 * breaking change would compile cleanly.
 */

const BASE: string = import.meta.env.VITE_API_URL ?? '';

export type DeploymentStatus =
  | 'QUEUED'
  | 'PROVISIONING'
  | 'BUILDING'
  | 'UPLOADING'
  | 'DEPLOYED'
  | 'FAILED'
  | 'CANCELLED';

export interface Project {
  projectId: string;
  name: string;
  repositoryUrl: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  activeDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Deployment {
  deploymentId: string;
  projectId: string;
  status: DeploymentStatus;
  branch: string;
  commitSha: string | null;
  commitMessage: string | null;
  trigger: string;
  framework: string | null;
  url: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  artifactBytes: number | null;
  fileCount: number | null;
  error: { code: string; message: string; exitCode?: number | null } | null;
}

export interface Me {
  userId: string;
  login: string;
  avatarUrl: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const TERMINAL: DeploymentStatus[] = ['DEPLOYED', 'FAILED', 'CANCELLED'];

export function isTerminal(status: DeploymentStatus): boolean {
  return TERMINAL.includes(status);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('session');

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `request failed with ${response.status}`,
    );
  }

  return body as T;
}

export const api = {
  me: () => request<Me>('/me'),

  listProjects: () => request<{ projects: Project[] }>('/projects'),

  getProject: (projectId: string) => request<Project>(`/projects/${projectId}`),

  createProject: (input: { name: string; repositoryUrl: string; defaultBranch?: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),

  listDeployments: (projectId: string) =>
    request<{ deployments: Deployment[]; nextCursor: string | null }>(
      `/projects/${projectId}/deployments?limit=50`,
    ),

  getDeployment: (deploymentId: string) => request<Deployment>(`/deployments/${deploymentId}`),

  deploy: (projectId: string, branch?: string) =>
    request<Deployment>(`/projects/${projectId}/deployments`, {
      method: 'POST',
      body: JSON.stringify(branch ? { branch } : {}),
    }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};

export function loginUrl(): string {
  return `${BASE}/auth/github`;
}
