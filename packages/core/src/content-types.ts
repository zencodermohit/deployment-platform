/**
 * Content-Type and Cache-Control rules for built artifacts.
 *
 * Lives in core, not in the builder, because the same rules must be applied by
 * whatever writes the files: the local publisher today, S3 `PutObject` in M2.
 * Getting Content-Type wrong means the browser downloads your HTML instead of
 * rendering it, which is a confusing failure to debug after the fact.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function contentTypeFor(relPath: string): string {
  const i = relPath.lastIndexOf('.');
  if (i < 0) return DEFAULT_CONTENT_TYPE;
  return TYPES[relPath.slice(i).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_REVALIDATE = 'public, max-age=0, must-revalidate';

/**
 * Fingerprinted filenames (`app.4f3a9b2c.js`) can be cached forever, because a
 * content change produces a new name. Everything else must revalidate, or a
 * rollback would not be visible to anyone holding a cached copy.
 */
const FINGERPRINTED = /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i;

export function cacheControlFor(relPath: string): string {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return CACHE_REVALIDATE;
  if (lower.endsWith('/service-worker.js') || lower === 'service-worker.js') return CACHE_REVALIDATE;
  return FINGERPRINTED.test(relPath) ? CACHE_IMMUTABLE : CACHE_REVALIDATE;
}
