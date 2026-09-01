/**
 * Identifier generation.
 *
 * Every id is 128 bits of randomness. Sequential ids (dep_1, dep_2) would be a
 * real vulnerability here, not a style preference: deployment ids appear in
 * public URLs, so a guessable id lets anyone enumerate other people's sites.
 * Threat T5 in docs/05-threat-model.md.
 */

const PREFIXES = {
  user: 'usr',
  project: 'prj',
  deployment: 'dep',
  session: 'ses',
  /** Per-deployment token the build container uses to report status (ADR-0009). */
  statusToken: 'stk',
} as const;

export type IdKind = keyof typeof PREFIXES;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${randomHex(16)}`;
}

export const generateUserId = (): string => generateId('user');
export const generateProjectId = (): string => generateId('project');
export const generateDeploymentId = (): string => generateId('deployment');
export const generateSessionId = (): string => generateId('session');

/** 256 bits, because this one is a bearer credential rather than a name. */
export function generateStatusToken(): string {
  return `${PREFIXES.statusToken}_${randomHex(32)}`;
}

export function isValidId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${PREFIXES[kind]}_[0-9a-f]{32}$`).test(value);
}

/**
 * The hostname a deployment is served at.
 *
 * Underscores are not legal in hostnames, so `dep_9c21` becomes `dep-9c21`.
 * Missing this produces a certificate that silently fails to match.
 */
export function deploymentHostname(deploymentId: string, domain: string): string {
  return `${deploymentId.replace(/_/g, '-')}.${domain}`;
}

/**
 * Where a deployment's artifacts live. Derived on the server from ids alone —
 * never from anything a client sends, which is what makes path traversal
 * impossible by construction rather than by filtering (threat T6).
 */
export function artifactPrefix(projectId: string, deploymentId: string): string {
  return `projects/${projectId}/deployments/${deploymentId}`;
}
