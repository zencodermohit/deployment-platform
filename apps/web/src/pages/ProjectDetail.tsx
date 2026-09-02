import { useCallback, useEffect, useState } from 'react';
import { api, isTerminal, type Deployment, type Project } from '../api';
import { ago, duration, StatusPill } from '../components';

export function ProjectDetail({ projectId }: { projectId: string }): JSX.Element {
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getProject(projectId).then(setProject).catch(() => setProject(null));
    api
      .listDeployments(projectId)
      .then((r) => setDeployments(r.deployments))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  useEffect(load, [load]);

  // Poll only while something is actually running. Polling a finished list
  // forever is the easy way to make an idle dashboard cost money.
  useEffect(() => {
    const live = deployments?.some((d) => !isTerminal(d.status));
    if (!live) return;

    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [deployments, load]);

  const deploy = (): void => {
    setBusy(true);
    setError(null);
    api
      .deploy(projectId)
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="crumbs">
        <a href="#/">projects</a> / {project?.name ?? projectId}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2>{project?.name ?? 'Project'}</h2>
          <p className="sub">
            {project ? (
              <a href={project.repositoryUrl} target="_blank" rel="noreferrer">
                {project.owner}/{project.repo}
              </a>
            ) : (
              projectId
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {project?.url && (
            <a href={project.url} target="_blank" rel="noreferrer">
              <button>Live site ↗</button>
            </a>
          )}
          <button className="primary" onClick={deploy} disabled={busy || !project}>
            {busy ? 'Starting…' : 'Deploy'}
          </button>
        </div>
      </div>

      {error && <div className="banner">{error}</div>}

      {deployments === null ? (
        <div className="loading">loading…</div>
      ) : deployments.length === 0 ? (
        <div className="empty">No deployments yet. Press Deploy to build the default branch.</div>
      ) : (
        <table className="deployments">
          <thead>
            <tr>
              <th>status</th>
              <th>deployment</th>
              <th className="hide-sm">branch</th>
              <th className="hide-sm">took</th>
              <th>when</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.deploymentId}>
                <td>
                  <StatusPill status={d.status} />
                </td>
                <td>
                  <a className="mono" href={`#/deployments/${d.deploymentId}`}>
                    {d.deploymentId.slice(0, 14)}…
                  </a>
                </td>
                <td className="mono hide-sm">{d.branch}</td>
                <td className="mono hide-sm">{duration(d.durationMs)}</td>
                <td className="mono">{ago(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
