/**
 * Small helpers shared by the three worker Lambdas.
 */

/** Read a required environment variable, or fail loudly at first use. */
export function env(key: string, fallback?: string): string {
  const value = process.env[key]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} is not set`);
}

export type Level = 'debug' | 'info' | 'warn' | 'error';

/** One JSON object per line, matching the builder's format so logs read alike. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
