import { useEffect, useState } from 'react';
import { api, ApiError, type Project } from '../api';
import { ago } from '../components';

export function Projects(): JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');

  const load = (): void => {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(load, []);

  const create = (event: React.FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    api
      .createProject({ name, repositoryUrl })
      .then(() => {
        setName('');
        setRepositoryUrl('');
        load();
      })
      // The API's messages are written to be shown: "only github.com
      // repositories are supported" is more use than "Bad Request".
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <h2>Projects</h2>
      <p className="sub">A project is one GitHub repository. Deploying builds its default branch.</p>

      {error && <div className="banner">{error}</div>}

      <form className="new-project" onSubmit={create}>
        <div className="fields">
          <input
            placeholder="my blog"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            placeholder="https://github.com/owner/repo"
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
            required
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>

      {projects === null ? (
        <div className="loading">loading…</div>
      ) : projects.length === 0 ? (
        <div className="empty">No projects yet. Add a public GitHub repository above.</div>
      ) : (
        <div className="grid">
          {projects.map((project) => (
            <a className="card" key={project.projectId} href={`#/projects/${project.projectId}`}>
              <div className="row">
                <div>
                  <div className="name">{project.name}</div>
                  <div className="repo">
                    {project.owner}/{project.repo} · {project.defaultBranch}
                  </div>
                </div>
                <div className="spacer" />
                <span className="mono" style={{ color: 'var(--text-3)' }}>
                  {ago(project.updatedAt)}
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
