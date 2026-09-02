import type { Deployment, DeploymentStatus } from './api';

const TONE: Record<DeploymentStatus, 'running' | 'ok' | 'bad' | 'idle'> = {
  QUEUED: 'idle',
  PROVISIONING: 'running',
  BUILDING: 'running',
  UPLOADING: 'running',
  DEPLOYED: 'ok',
  FAILED: 'bad',
  CANCELLED: 'idle',
};

export function StatusPill({ status }: { status: DeploymentStatus }): JSX.Element {
  return (
    <span className={`pill ${TONE[status]}`}>
      <span className="dot" />
      {status.toLowerCase()}
    </span>
  );
}

/** The order a deployment actually moves through. See docs/01-architecture.md §6. */
const STEPS: { key: DeploymentStatus; label: string; at: keyof Deployment | null }[] = [
  { key: 'QUEUED', label: 'queued', at: 'createdAt' },
  { key: 'PROVISIONING', label: 'starting container', at: 'startedAt' },
  { key: 'BUILDING', label: 'building', at: null },
  { key: 'UPLOADING', label: 'uploading', at: null },
  { key: 'DEPLOYED', label: 'deployed', at: 'finishedAt' },
];

export function Timeline({ deployment }: { deployment: Deployment }): JSX.Element {
  const failed = deployment.status === 'FAILED';
  const reached = STEPS.findIndex((s) => s.key === deployment.status);
  // A failed deployment stops wherever it got to; the index is unknown because
  // FAILED is not one of the steps, so treat everything before it as done.
  const current = failed ? STEPS.length : reached;

  return (
    <div className="timeline">
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const state = failed && index === STEPS.length - 1 ? 'failed' : done ? 'done' : active ? 'active' : 'pending';

        const timestamp = step.at ? (deployment[step.at] as string | null) : null;

        return (
          <div key={step.key} className={`step ${state}`}>
            <span className="mark">
              {state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'active' ? '●' : ''}
            </span>
            <span className="label">
              {failed && index === STEPS.length - 1 ? 'failed' : step.label}
            </span>
            <span className="at">{timestamp ? new Date(timestamp).toLocaleTimeString() : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function bytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
