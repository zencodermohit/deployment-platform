import { describe, expect, it } from 'vitest';
import { detectFramework } from '@platform/core';

const NO_HTML = { hasIndexHtml: false };
const HTML = { hasIndexHtml: true };

describe('detectFramework', () => {
  it('detects Vite from devDependencies', () => {
    const r = detectFramework({ pkg: { devDependencies: { vite: '^5' } }, ...NO_HTML });
    expect(r.ok && r.framework.id).toBe('vite');
    expect(r.ok && r.framework.outputDir).toBe('dist');
  });

  it('detects Create React App', () => {
    const r = detectFramework({ pkg: { dependencies: { 'react-scripts': '5' } }, ...NO_HTML });
    expect(r.ok && r.framework.id).toBe('cra');
    expect(r.ok && r.framework.outputDir).toBe('build');
  });

  it('detects Astro', () => {
    const r = detectFramework({ pkg: { devDependencies: { astro: '^4' } }, ...NO_HTML });
    expect(r.ok && r.framework.id).toBe('astro');
  });

  it('accepts Next.js only with output: export', () => {
    const pkg = { dependencies: { next: '^15' } };
    const withExport = detectFramework({
      pkg,
      nextConfigText: "module.exports = { output: 'export' };",
      ...NO_HTML,
    });
    expect(withExport.ok && withExport.framework.id).toBe('next');
    expect(withExport.ok && withExport.framework.outputDir).toBe('out');
  });

  it('rejects Next.js without static export, and says why', () => {
    const r = detectFramework({
      pkg: { dependencies: { next: '^15' } },
      nextConfigText: 'module.exports = { reactStrictMode: true };',
      ...NO_HTML,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/server/i);
    expect(!r.ok && r.reason).toMatch(/output: 'export'/);
  });

  it('rejects Next.js with no config file at all', () => {
    const r = detectFramework({ pkg: { dependencies: { next: '^15' } }, ...NO_HTML });
    expect(r.ok).toBe(false);
  });

  it('tolerates whitespace and quote styles in the export check', () => {
    for (const text of [
      'export default { output:"export" }',
      'module.exports = {\n  output :  `export`,\n}',
      "const c={output:'export'};export default c",
    ]) {
      const r = detectFramework({
        pkg: { dependencies: { next: '^15' } },
        nextConfigText: text,
        ...NO_HTML,
      });
      expect(r.ok, text).toBe(true);
    }
  });

  it('prefers Next.js over Vite when both are present', () => {
    const r = detectFramework({
      pkg: { dependencies: { next: '^15' }, devDependencies: { vite: '^5' } },
      nextConfigText: "output: 'export'",
      ...NO_HTML,
    });
    expect(r.ok && r.framework.id).toBe('next');
  });

  it('treats a package-less directory with index.html as a static site', () => {
    const r = detectFramework({ pkg: null, ...HTML });
    expect(r.ok && r.framework.id).toBe('static');
    expect(r.ok && r.framework.buildCommand).toBeNull();
    expect(r.ok && r.framework.needsInstall).toBe(false);
  });

  it('rejects a package-less directory with nothing to serve', () => {
    const r = detectFramework({ pkg: null, ...NO_HTML });
    expect(r.ok).toBe(false);
  });

  it('rejects an unrecognised project that has a build script', () => {
    const r = detectFramework({ pkg: { scripts: { build: 'make all' } }, ...NO_HTML });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no recognised framework/i);
  });

  it('accepts a package.json with no build script but an index.html', () => {
    const r = detectFramework({ pkg: { name: 'x' }, ...HTML });
    expect(r.ok && r.framework.id).toBe('static');
  });
});
