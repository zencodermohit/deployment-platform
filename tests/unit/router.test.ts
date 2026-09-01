/**
 * Tests for the CloudFront Function that routes requests to S3 prefixes.
 *
 * This is the highest-risk code in the edge stack and the slowest to debug in
 * place — every change is a deploy, and a mistake serves one tenant's files
 * under another tenant's hostname. Testing it locally is worth the small amount
 * of loading machinery below.
 *
 * The real source is loaded verbatim; only the `cloudfront` import (which only
 * exists inside the CloudFront runtime) is swapped for a stub, and an export is
 * appended so it can be imported. The deployed file stays exactly as CloudFront
 * requires it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../helpers.js';

type CfResponse = {
  statusCode?: number;
  statusDescription?: string;
  uri?: string;
  headers?: Record<string, { value: string }>;
  body?: string;
};

let handler: (event: unknown) => Promise<CfResponse>;
let store: Map<string, string>;
let tempDir: string;

beforeAll(async () => {
  const source = await readFile(
    path.join(ROOT, 'infra', 'stacks', 'edge', 'router.js'),
    'utf8',
  );

  const shimmed =
    source.replace(
      /^import cf from 'cloudfront';$/m,
      'const cf = globalThis.__cfStub;',
    ) + '\nexport { handler, resolvePath, join, parseTarget };\n';

  // The store the stub reads. Rebuilt per test via `store.clear()`.
  store = new Map();
  (globalThis as Record<string, unknown>)['__cfStub'] = {
    kvs: () => ({
      get: (key: string): Promise<string> => {
        const value = store.get(key);
        // CloudFront's KVS rejects on a missing key rather than resolving null.
        return value === undefined
          ? Promise.reject(new Error(`key not found: ${key}`))
          : Promise.resolve(value);
      },
    }),
  };

  tempDir = await mkdtemp(path.join(tmpdir(), 'router-'));
  const file = path.join(tempDir, 'router.mjs');
  await writeFile(file, shimmed, 'utf8');

  const mod = (await import(pathToFileURL(file).href)) as {
    handler: typeof handler;
  };
  handler = mod.handler;

  expect(shimmed).not.toContain("from 'cloudfront'");
});

function request(host: string, uri: string): unknown {
  return { request: { uri, headers: { host: { value: host } } } };
}

const PREFIX = 'projects/prj_1/deployments/dep_9c21';

describe('router — custom domain', () => {
  beforeAll(() => {
    store.set('dep-9c21.example.com', JSON.stringify({ p: PREFIX }));
    store.set('spa.example.com', JSON.stringify({ p: PREFIX, spa: true }));
    store.set('bare.example.com', PREFIX);
  });

  it('maps the root to index.html inside the deployment prefix', async () => {
    const r = await handler(request('dep-9c21.example.com', '/'));
    expect(r.uri).toBe(`/${PREFIX}/index.html`);
  });

  it('appends index.html to a directory path', async () => {
    const r = await handler(request('dep-9c21.example.com', '/about/'));
    expect(r.uri).toBe(`/${PREFIX}/about/index.html`);
  });

  it('appends /index.html to an extensionless path', async () => {
    const r = await handler(request('dep-9c21.example.com', '/about'));
    expect(r.uri).toBe(`/${PREFIX}/about/index.html`);
  });

  it('leaves a real file path alone', async () => {
    const r = await handler(request('dep-9c21.example.com', '/assets/app.a1b2c3.js'));
    expect(r.uri).toBe(`/${PREFIX}/assets/app.a1b2c3.js`);
  });

  it('is case-insensitive about the host header', async () => {
    const r = await handler(request('DEP-9c21.Example.COM', '/'));
    expect(r.uri).toBe(`/${PREFIX}/index.html`);
  });

  it('accepts a bare prefix string as well as JSON', async () => {
    const r = await handler(request('bare.example.com', '/about/'));
    expect(r.uri).toBe(`/${PREFIX}/about/index.html`);
  });

  it('404s an unknown hostname', async () => {
    const r = await handler(request('nobody.example.com', '/'));
    expect(r.statusCode).toBe(404);
    expect(r.uri).toBeUndefined();
  });
});

describe('router — SPA mode', () => {
  it('sends extensionless paths to the deployment index, not a subdirectory', async () => {
    const r = await handler(request('spa.example.com', '/dashboard/settings'));
    expect(r.uri).toBe(`/${PREFIX}/index.html`);
  });

  it('still serves real assets directly', async () => {
    const r = await handler(request('spa.example.com', '/assets/app.js'));
    expect(r.uri).toBe(`/${PREFIX}/assets/app.js`);
  });
});

describe('router — CloudFront default domain, path mode', () => {
  beforeAll(() => {
    store.set('dep_9c21', JSON.stringify({ p: PREFIX }));
  });

  it('reads the deployment id from the first path segment', async () => {
    const r = await handler(request('d111abc.cloudfront.net', '/d/dep_9c21/about/'));
    expect(r.uri).toBe(`/${PREFIX}/about/index.html`);
  });

  it('handles the bare deployment root with no trailing slash', async () => {
    const r = await handler(request('d111abc.cloudfront.net', '/d/dep_9c21'));
    expect(r.uri).toBe(`/${PREFIX}/index.html`);
  });

  it('404s a request with no /d/ prefix', async () => {
    const r = await handler(request('d111abc.cloudfront.net', '/index.html'));
    expect(r.statusCode).toBe(404);
  });

  it('404s an id that is not id-shaped', async () => {
    const r = await handler(request('d111abc.cloudfront.net', '/d/../../etc/passwd'));
    expect(r.statusCode).toBe(404);
  });
});

describe('router — path traversal', () => {
  const attacks = [
    '/../dep_other/index.html',
    '/assets/../../../secrets.txt',
    '/%2e%2e/%2e%2e/other',
    '/%2E%2E/other',
    '/a/..%2fb',
  ];

  it.each(attacks)('rejects %s', async (uri) => {
    const r = await handler(request('dep-9c21.example.com', uri));
    expect(r.statusCode).toBe(400);
    expect(r.uri).toBeUndefined();
  });

  it('never emits a uri that escapes the deployment prefix', async () => {
    for (const uri of [...attacks, '/', '/about/', '/assets/x.js']) {
      const r = await handler(request('dep-9c21.example.com', uri));
      if (r.uri !== undefined) {
        expect(r.uri.startsWith(`/${PREFIX}/`)).toBe(true);
        expect(r.uri).not.toContain('..');
      }
    }
  });
});

describe('router — malformed input', () => {
  it('404s when the host header is missing entirely', async () => {
    const r = await handler({ request: { uri: '/', headers: {} } });
    expect(r.statusCode).toBe(404);
  });

  it('404s when the stored value is not usable JSON', async () => {
    store.set('broken.example.com', '{not json');
    const r = await handler(request('broken.example.com', '/'));
    expect(r.statusCode).toBe(404);
  });

  it('404s when the stored JSON has no prefix', async () => {
    store.set('empty.example.com', JSON.stringify({ spa: true }));
    const r = await handler(request('empty.example.com', '/'));
    expect(r.statusCode).toBe(404);
  });

  it('normalises a stored prefix with stray slashes', async () => {
    store.set('slashes.example.com', JSON.stringify({ p: `/${PREFIX}/` }));
    const r = await handler(request('slashes.example.com', '/'));
    expect(r.uri).toBe(`/${PREFIX}/index.html`);
  });
});

describe('router — deployable source constraints', () => {
  it('keeps the cloudfront import that the runtime requires', async () => {
    const source = await readFile(
      path.join(ROOT, 'infra', 'stacks', 'edge', 'router.js'),
      'utf8',
    );
    expect(source).toContain("import cf from 'cloudfront'");
    // CloudFront rejects a function that exports anything.
    expect(source).not.toMatch(/^export /m);
    // The runtime caps function source at 10 KB.
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(10 * 1024);
  });
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
