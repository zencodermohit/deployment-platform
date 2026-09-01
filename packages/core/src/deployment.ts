/**
 * The deployment state machine.
 *
 * The transition table below is the single source of truth. The API, the
 * dispatcher, the build container's status callback, the reconciler and the
 * sweeper all go through `assertTransition`, and the DynamoDB write that
 * follows carries a ConditionExpression built from the same table — so an
 * invalid move is rejected by the database even if application code has a bug.
 *
 * See docs/01-architecture.md §6.
 */

export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'PROVISIONING',
  'BUILDING',
  'UPLOADING',
  'DEPLOYED',
  'FAILED',
  'CANCELLED',
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Terminal states accept no further transitions. */
export const TERMINAL_STATUSES = ['DEPLOYED', 'FAILED', 'CANCELLED'] as const satisfies readonly DeploymentStatus[];

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: DeploymentStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly DeploymentStatus[]).includes(status);
}

/** Who is permitted to make a given move. Not enforced by IAM — a sanity rail. */
export type Actor = 'api' | 'dispatcher' | 'container' | 'reconciler' | 'sweeper';

export interface Transition {
  from: DeploymentStatus;
  to: DeploymentStatus;
  by: readonly Actor[];
  note: string;
}

export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'QUEUED',
    to: 'PROVISIONING',
    by: ['dispatcher'],
    note: 'The claim. Exactly one dispatcher wins this; duplicates exit cleanly.',
  },
  { from: 'PROVISIONING', to: 'BUILDING', by: ['container'], note: 'Container started.' },
  { from: 'BUILDING', to: 'UPLOADING', by: ['container'], note: 'Build succeeded.' },
  { from: 'UPLOADING', to: 'DEPLOYED', by: ['container'], note: 'Artifacts published.' },

  // Anything not yet terminal can fail, from several directions: the container
  // reports it, the reconciler notices the task died, or the sweeper finds it
  // past its deadline.
  ...(['QUEUED', 'PROVISIONING', 'BUILDING', 'UPLOADING'] as const).map(
    (from): Transition => ({
      from,
      to: 'FAILED',
      by: ['container', 'reconciler', 'sweeper', 'api'],
      note: 'Failure, reported or detected.',
    }),
  ),

  // Cancellation only before a container exists. Once a build is running there
  // is nothing useful to cancel — it will finish or time out shortly.
  { from: 'QUEUED', to: 'CANCELLED', by: ['api'], note: 'Cancelled before dispatch.' },
  { from: 'PROVISIONING', to: 'CANCELLED', by: ['api'], note: 'Cancelled before the container started.' },
];

export function canTransition(from: DeploymentStatus, to: DeploymentStatus, by?: Actor): boolean {
  return TRANSITIONS.some(
    (t) => t.from === from && t.to === to && (by === undefined || t.by.includes(by)),
  );
}

/** Every status that may legally precede `to`. Becomes the ConditionExpression. */
export function allowedPredecessors(to: DeploymentStatus, by?: Actor): DeploymentStatus[] {
  return TRANSITIONS.filter((t) => t.to === to && (by === undefined || t.by.includes(by))).map(
    (t) => t.from,
  );
}

export class InvalidTransitionError extends Error {
  readonly from: DeploymentStatus;
  readonly to: DeploymentStatus;
  readonly by: Actor | undefined;

  constructor(from: DeploymentStatus, to: DeploymentStatus, by?: Actor) {
    super(
      by
        ? `${by} may not move a deployment from ${from} to ${to}`
        : `a deployment cannot move from ${from} to ${to}`,
    );
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.by = by;
  }
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus, by?: Actor): void {
  if (!canTransition(from, to, by)) throw new InvalidTransitionError(from, to, by);
}

/** How a deployment was started. Shown in the UI and useful for abuse triage. */
export type DeploymentTrigger = 'manual' | 'webhook' | 'retry';

export interface DeploymentError {
  /** Matches the builder's exit-code taxonomy, e.g. BUILD_FAILED. */
  code: string;
  message: string;
  exitCode?: number | null;
}

export interface Deployment {
  deploymentId: string;
  projectId: string;
  userId: string;
  status: DeploymentStatus;

  repositoryUrl: string;
  owner: string;
  repo: string;
  branch: string;
  commitSha: string | null;
  commitMessage: string | null;
  trigger: DeploymentTrigger;

  framework: string | null;
  artifactPrefix: string;
  hostname: string;

  /** Written by the dispatcher; the reconciler needs it to match ECS events. */
  taskArn: string | null;
  logStreamName: string;
  /** SHA-256 of the status token. The token itself is never stored. */
  statusTokenHash: string | null;

  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** createdAt + timeout + slack. Drives the sweeper via the sparse GSI. */
  deadlineAt: string;
  durationMs: number | null;

  artifactBytes: number | null;
  fileCount: number | null;
  error: DeploymentError | null;
  retryOfDeploymentId: string | null;

  schemaVersion: number;
}

export interface Project {
  projectId: string;
  userId: string;
  name: string;
  repositoryUrl: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Newest successful deployment currently served for this project. */
  activeDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

export const SCHEMA_VERSION = 1;

/** Deadline = build timeout plus room for Fargate's cold start and cleanup. */
export const DEADLINE_SLACK_SEC = 120;

export function computeDeadline(createdAt: string, buildTimeoutSec: number): string {
  return new Date(
    new Date(createdAt).getTime() + (buildTimeoutSec + DEADLINE_SLACK_SEC) * 1000,
  ).toISOString();
}
