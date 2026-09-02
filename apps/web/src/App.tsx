import { useEffect, useState } from 'react';
import { api, loginUrl, type Me } from './api';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { DeploymentDetail } from './pages/DeploymentDetail';

/**
 * Hash routing rather than a router library.
 *
 * The dashboard is served from a path prefix (/d/dashboard/) on the platform's
 * own CloudFront distribution, so path-based routing would need the base path
 * threaded through every link. A hash sidesteps that entirely, and the whole
 * router is fifteen lines.
 */
function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');

  useEffect(() => {
    const onChange = (): void => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

/**
 * The OAuth callback returns the session in the URL fragment rather than the
 * query string: fragments are never sent to a server, so the token stays out of
 * access logs and Referer headers.
 */
function captureSessionFromFragment(): void {
  const hash = window.location.hash;
  const match = /[#&]session=([^&]+)/.exec(hash);
  if (!match?.[1]) return;

  localStorage.setItem('session', decodeURIComponent(match[1]));
  // Replace, not push: the token must not survive in history.
  window.history.replaceState(null, '', window.location.pathname + '#/');
  window.location.reload();
}

export function App(): JSX.Element {
  const route = useHashRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');

  useEffect(() => {
    captureSessionFromFragment();

    // Attempted even without a stored token. While authentication is disabled
    // the API answers anyway, which is what makes the dashboard usable before
    // the OAuth app exists; once it is enabled this simply 401s and the login
    // screen appears.
    api
      .me()
      .then((user) => {
        setMe(user);
        setState('in');
      })
      .catch(() => {
        // An expired or revoked session is indistinguishable from none.
        localStorage.removeItem('session');
        setState('out');
      });
  }, []);

  if (state === 'loading') {
    return (
      <div className="shell">
        <div className="loading">checking your session…</div>
      </div>
    );
  }

  if (state === 'out') return <Login />;

  const deployment = /^\/deployments\/([\w-]+)/.exec(route);
  const project = /^\/projects\/([\w-]+)/.exec(route);

  return (
    <div className="shell">
      <header className="top">
        <h1>
          <a href="#/" style={{ color: 'inherit', textDecoration: 'none' }}>
            Deployments
          </a>
        </h1>
        <div className="spacer" />
        {me && (
          <span className="who">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" />}
            {me.login}
          </span>
        )}
        <button
          onClick={() => {
            void api.logout().finally(() => {
              localStorage.removeItem('session');
              window.location.hash = '/';
              window.location.reload();
            });
          }}
        >
          Sign out
        </button>
      </header>

      {deployment?.[1] ? (
        <DeploymentDetail deploymentId={deployment[1]} />
      ) : project?.[1] ? (
        <ProjectDetail projectId={project[1]} />
      ) : (
        <Projects />
      )}
    </div>
  );
}

function Login(): JSX.Element {
  return (
    <div className="shell login">
      <div className="inner">
        <h2>Deployments</h2>
        <p>Connect a GitHub repository and it builds in an isolated container.</p>
        <a href={loginUrl()}>
          <button className="primary">Continue with GitHub</button>
        </a>
        <p className="note">
          Only <code>read:user</code> is requested — enough to know who you are, and nothing
          more. The access token is used once and discarded.
        </p>
      </div>
    </div>
  );
}
