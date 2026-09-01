/**
 * Framework detection.
 *
 * Two rules that matter more than the table itself:
 *
 * 1. Build commands come from THIS table, keyed by detected framework. They are
 *    never read from the repository's `scripts`, and never passed to a shell.
 *    That is what closes the command-injection hole (threat T15).
 *
 * 2. We never execute the repository's config files to inspect them. Reading
 *    next.config.js by `import()`ing it would be running untrusted code during
 *    detection, before any sandboxing decision has been made. We scan text.
 *
 * Unknown project shapes are REJECTED, not guessed. Deploying an empty directory
 * is a worse outcome than refusing. See docs/00-scope.md.
 */

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface Framework {
  id: string;
  label: string;
  /** argv form. `null` means the project needs no build step. */
  buildCommand: string[] | null;
  /** Directory, relative to the repo root, holding the finished site. */
  outputDir: string;
  /** Whether dependencies must be installed before building. */
  needsInstall: boolean;
}

export const FRAMEWORKS = {
  next: {
    id: 'next',
    label: 'Next.js (static export)',
    buildCommand: ['npm', 'run', 'build'],
    outputDir: 'out',
    needsInstall: true,
  },
  astro: {
    id: 'astro',
    label: 'Astro',
    buildCommand: ['npm', 'run', 'build'],
    outputDir: 'dist',
    needsInstall: true,
  },
  vite: {
    id: 'vite',
    label: 'Vite',
    buildCommand: ['npm', 'run', 'build'],
    outputDir: 'dist',
    needsInstall: true,
  },
  cra: {
    id: 'cra',
    label: 'Create React App',
    buildCommand: ['npm', 'run', 'build'],
    outputDir: 'build',
    needsInstall: true,
  },
  static: {
    id: 'static',
    label: 'Plain static site',
    buildCommand: null,
    outputDir: '.',
    needsInstall: false,
  },
} as const satisfies Record<string, Framework>;

export type FrameworkId = keyof typeof FRAMEWORKS;

export type DetectResult =
  | { ok: true; framework: Framework }
  | { ok: false; reason: string };

export interface DetectInput {
  /** Parsed package.json, or null when the repository has none. */
  pkg: PackageJson | null;
  /** Raw text of next.config.{js,mjs,ts}, concatenated. Never executed. */
  nextConfigText?: string | undefined;
  /** True when the repo root has an index.html. */
  hasIndexHtml: boolean;
}

function dep(pkg: PackageJson | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

/**
 * Matches `output: 'export'` / `output: "export"` with flexible whitespace.
 * A static scan, not an evaluation: worst case we misjudge an exotic config and
 * fail later at the "output directory missing" check, which is a safe failure.
 */
const STATIC_EXPORT = /\boutput\s*:\s*['"`]export['"`]/;

export function detectFramework(input: DetectInput): DetectResult {
  const { pkg, nextConfigText, hasIndexHtml } = input;

  // No package.json at all: only a plain static site is possible.
  if (!pkg) {
    return hasIndexHtml
      ? { ok: true, framework: FRAMEWORKS.static }
      : { ok: false, reason: 'no package.json and no index.html found in the repository root' };
  }

  const hasBuildScript = typeof pkg.scripts?.['build'] === 'string';

  // Next.js is checked first: every Next app also depends on React, and most
  // also pull in something Vite-shaped through their tooling.
  if (dep(pkg, 'next')) {
    if (!nextConfigText || !STATIC_EXPORT.test(nextConfigText)) {
      return {
        ok: false,
        reason:
          'Next.js project without static export. `next build` produces a server, not files ' +
          "we can serve from a CDN. Add `output: 'export'` to next.config.js, or deploy a " +
          'static framework. See docs/adr/0006-static-only-mvp.md.',
      };
    }
    return { ok: true, framework: FRAMEWORKS.next };
  }

  if (dep(pkg, 'astro')) return { ok: true, framework: FRAMEWORKS.astro };
  if (dep(pkg, 'vite')) return { ok: true, framework: FRAMEWORKS.vite };
  if (dep(pkg, 'react-scripts')) return { ok: true, framework: FRAMEWORKS.cra };

  // A package.json with no build script and an index.html is just a static site.
  if (!hasBuildScript && hasIndexHtml) {
    return { ok: true, framework: FRAMEWORKS.static };
  }

  if (hasBuildScript) {
    return {
      ok: false,
      reason:
        'the project has a build script but no recognised framework. Supported: Vite, ' +
        "Create React App, Astro, Next.js with output: 'export', or a plain static site.",
    };
  }

  return { ok: false, reason: 'no recognised framework and no index.html in the repository root' };
}
