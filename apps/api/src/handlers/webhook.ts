/**
 * GitHub webhooks: a push builds automatically.
 *
 *   POST /projects/{projectId}/webhook   (authenticated) — enable it, get a
 *                                          secret and the URL to give GitHub.
 *   POST /webhooks/github/{projectId}    (GitHub calls this) — signature-checked,
 *                                          creates a deployment on a matching push.
 *
 * The webhook is just another door into the deployment pipeline that already
 * exists and is already bounded: the daily quota and concurrency cap apply to a
 * webhook build exactly as to a manual one, so a push flood cannot outspend a
 * click flood. There is no new trust boundary — only a new, signature-verified
 * way through an existing one.
 */

import type { Project } from '@platform/core';
import { getProjectById, setWebhookSecret } from '@platform/data';
import { startDeployment } from '../deploy.js';
import { authorizeProject, identify } from '../http/auth.js';
import { badRequest, notFound, unauthenticated } from '../http/errors.js';
import { json, type HttpRequest, type HttpResponse } from '../http/response.js';
import { generateWebhookSecret, verifyGithubSignature } from '../auth/webhook.js';

/**
 * Enable auto-deploy for a project.
 *
 * Generates a secret, stores it on the project, and returns it ONCE along with
 * the URL to register in GitHub. The secret is never returned again — the
 * project presenter does not expose it, and a second call rotates it, which is
 * the only way to see a value after this.
 */
export async function handleEnableWebhook(req: HttpRequest): Promise<HttpResponse> {
  const caller = await identify(req);
  const projectId = req.pathParameters['projectId'];
  if (!projectId) throw notFound('project');

  const project = await authorizeProject(caller, projectId);

  const secret = generateWebhookSecret();
  await setWebhookSecret(project.userId, project.projectId, secret);

  const apiBase = process.env['API_PUBLIC_URL'] ?? '';

  return json(200, {
    // Everything GitHub's "Add webhook" form needs.
    url: `${apiBase}/webhooks/github/${project.projectId}`,
    contentType: 'application/json',
    secret,
    events: ['push'],
    note: 'Store the secret now; it is not shown again. Re-enabling rotates it.',
  });
}

interface PushPayload {
  ref?: string;
  deleted?: boolean;
  after?: string;
  head_commit?: { id?: string; message?: string } | null;
  repository?: { full_name?: string };
}

/**
 * The endpoint GitHub calls on every event.
 *
 * Order is deliberate: identify the project, verify the signature with THAT
 * project's secret, and only then look at the payload. Verifying before trusting
 * any field of the body is the whole point.
 */
export async function handleWebhook(req: HttpRequest): Promise<HttpResponse> {
  const projectId = req.pathParameters['projectId'];
  if (!projectId) throw notFound('webhook');

  // Loaded by id via the index — a webhook has no user to scope by. The 404 for
  // a missing project is the same one a wrong id gets, so this cannot enumerate.
  const project = await getProjectById(projectId);
  if (!project || !project.webhookSecret) throw notFound('webhook');

  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.rawBody ?? '';

  if (!verifyGithubSignature(rawBody, signature, project.webhookSecret)) {
    // 401, and nothing more specific: a valid-but-wrong signature and a missing
    // one are answered identically.
    throw unauthenticated('invalid webhook signature');
  }

  const event = req.headers['x-github-event'];

  // GitHub sends a `ping` when a webhook is first created. Acknowledge it so the
  // setup shows a green tick, but do nothing.
  if (event === 'ping') return json(200, { ok: true, pong: true });

  if (event !== 'push') {
    // Tags, PRs, stars — accepted so GitHub does not mark the delivery failed,
    // but ignored. Only pushes build.
    return json(200, { ok: true, ignored: event });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(rawBody) as PushPayload;
  } catch {
    throw badRequest('webhook body is not valid JSON');
  }

  const decision = shouldBuild(payload, project);
  if (!decision.build) {
    return json(200, { ok: true, skipped: decision.reason });
  }

  const deployment = await startDeployment(project, {
    branch: decision.branch,
    commitSha: payload.after ?? payload.head_commit?.id ?? null,
    commitMessage: payload.head_commit?.message ?? null,
    trigger: 'webhook',
  });

  return json(202, {
    deploymentId: deployment.deploymentId,
    status: deployment.status,
    branch: deployment.branch,
  });
}

type Decision = { build: true; branch: string } | { build: false; reason: string };

/**
 * Whether a push should trigger a build.
 *
 * Only the project's default branch, and never a branch deletion — otherwise
 * every feature branch and every `git push --delete` would start a build, which
 * is both noise and spend.
 */
function shouldBuild(payload: PushPayload, project: Project): Decision {
  if (payload.deleted === true) return { build: false, reason: 'branch deleted' };

  const ref = payload.ref ?? '';
  if (!ref.startsWith('refs/heads/')) {
    // A tag push is refs/tags/*. Not a branch, so not a deployment.
    return { build: false, reason: 'not a branch push' };
  }

  const branch = ref.slice('refs/heads/'.length);
  if (branch !== project.defaultBranch) {
    return { build: false, reason: `not the default branch (${project.defaultBranch})` };
  }

  return { build: true, branch };
}
