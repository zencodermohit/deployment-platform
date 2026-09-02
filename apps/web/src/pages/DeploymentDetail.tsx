import { useCallback, useEffect, useState } from 'react';
import { api, isTerminal, type Deployment } from '../api';
import { bytes, duration, StatusPill, Timeline } from '../components';

export function DeploymentDetail({ deploymentId }: { deploymentId: string }): JSX.Element {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = (
    run: () => Promise<unknown>,
    after: (result: unknown) => string,
  ): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    run()
      .then((result) => {
        setNote(after(result));
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const load = useCallback(() => {
    api
      .getDeployment(deploymentId)
      .then(setDeployment)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [deploymentId]);

  useEffect(load, [load]);

  // Every two seconds while it is live, then stop. A finished deployment never
  // changes again, so there is nothing to poll for.
  useEffect(() => {
    if (!deployment || isTerminal(deployment.status)) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [deployment, load]);

  if (error) return <div className="banner">{error}</div>;
  if (!deployment) return <div className="loading">loading…</div>;

  return (
    <>
      <div className="crumbs">
        <a href="#/">projects</a> / <a href={`#/projects/${deployment.projectId}`}>project</a> /{' '}
        {deployment.deploymentId.slice(0, 14)}…
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Deployment</h2>
        <StatusPill status={deployment.status} />
      </div>
      <p className="sub mono">{deployment.deploymentId}</p>

      <Timeline deployment={deployment} />

      {deployment.error && (
        <div className="error-box">
          <span className="code">
            {deployment.error.code}
            {deployment.error.exitCode != null ? ` · exit ${deployment.error.exitCode}` : ''}
          </span>
          {/* The builder's messages are written for a person to read — "Next.js
              project without static export" rather than "exit 11". */}
          <p>{deployment.error.message}</p>
        </div>
      )}

      {note && (
        <p className="sub mono" style={{ color: 'var(--ok)' }}>
          {note}
        </p>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        {deployment.status === 'DEPLOYED' && deployment.url && (
          <a href={deployment.url} target="_blank" rel="noreferrer">
            <button className="primary">Open site ↗</button>
          </a>
        )}

        {deployment.status === 'DEPLOYED' && (
          <button
            disabled={busy}
            onClick={() =>
              act(
                () => api.promote(deployment.deploymentId),
                (r) => {
                  const { tookMs } = r as { tookMs: number };
                  // Worth showing the number: it is the difference between a
                  // pointer swap and a rebuild.
                  return `now serving this deployment — ${tookMs}ms, no rebuild`;
                },
              )
            }
          >
            Promote to live
          </button>
        )}

        {isTerminal(deployment.status) && (
          <button
            disabled={busy}
            onClick={() =>
              act(
                () => api.retry(deployment.deploymentId),
                (r) => {
                  const { deploymentId } = r as { deploymentId: string };
                  window.location.hash = `/deployments/${deploymentId}`;
                  return 'started a new deployment';
                },
              )
            }
          >
            Retry
          </button>
        )}

        {(deployment.status === 'QUEUED' || deployment.status === 'PROVISIONING') && (
          <button
            disabled={busy}
            onClick={() => act(() => api.cancel(deployment.deploymentId), () => 'cancelled')}
          >
            Cancel
          </button>
        )}
      </div>

      <dl className="facts">
        <dt>branch</dt>
        <dd className="mono">{deployment.branch}</dd>

        <dt>commit</dt>
        <dd className="mono">{deployment.commitSha?.slice(0, 12) ?? '—'}</dd>

        <dt>framework</dt>
        <dd className="mono">{deployment.framework ?? '—'}</dd>

        <dt>trigger</dt>
        <dd className="mono">{deployment.trigger}</dd>

        <dt>duration</dt>
        <dd className="mono">{duration(deployment.durationMs)}</dd>

        <dt>artifacts</dt>
        <dd className="mono">
          {deployment.fileCount ?? '—'} files · {bytes(deployment.artifactBytes)}
        </dd>

        <dt>started</dt>
        <dd className="mono">
          {deployment.startedAt ? new Date(deployment.startedAt).toLocaleString() : '—'}
        </dd>

        <dt>finished</dt>
        <dd className="mono">
          {deployment.finishedAt ? new Date(deployment.finishedAt).toLocaleString() : '—'}
        </dd>
      </dl>

      {!isTerminal(deployment.status) && (
        <p className="sub mono" style={{ color: 'var(--text-3)' }}>
          refreshing every 2s…
        </p>
      )}
    </>
  );
}
