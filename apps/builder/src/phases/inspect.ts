/**
 * Phase 2 — inspect: work out what kind of project this is.
 *
 * Reads files as text. Never imports or evaluates anything from the repository:
 * at this point nothing has been sandboxed beyond the container itself, and
 * `import()`ing a user's next.config.js would be running their code to decide
 * how to run their code.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  BuildError,
  detectFramework,
  type Framework,
  type Logger,
  type PackageJson,
} from '@platform/core';

export interface InspectResult {
  framework: Framework;
  packageJson: PackageJson | null;
  hasLockfile: boolean;
}

const NEXT_CONFIG_FILES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
];

export async function inspectProject(rootDir: string, log: Logger): Promise<InspectResult> {
  const packageJson = await readPackageJson(rootDir, log);
  const hasIndexHtml = await exists(path.join(rootDir, 'index.html'));
  const nextConfigText = await readNextConfigs(rootDir);

  const detection = detectFramework({ pkg: packageJson, nextConfigText, hasIndexHtml });
  if (!detection.ok) {
    throw new BuildError('UNSUPPORTED_FRAMEWORK', detection.reason);
  }

  const hasLockfile = await exists(path.join(rootDir, 'package-lock.json'));

  log.info(`detected ${detection.framework.label}`, {
    framework: detection.framework.id,
    outputDir: detection.framework.outputDir,
    hasLockfile,
  });

  return { framework: detection.framework, packageJson, hasLockfile };
}

async function readPackageJson(rootDir: string, log: Logger): Promise<PackageJson | null> {
  const file = path.join(rootDir, 'package.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    log.debug('no package.json in repository root');
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as PackageJson;
  } catch (e) {
    throw new BuildError(
      'UNSUPPORTED_FRAMEWORK',
      `package.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Concatenated so one regex scan covers whichever variant the project uses. */
async function readNextConfigs(rootDir: string): Promise<string | undefined> {
  const parts: string[] = [];
  for (const name of NEXT_CONFIG_FILES) {
    try {
      parts.push(await readFile(path.join(rootDir, name), 'utf8'));
    } catch {
      /* absent, which is the common case */
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
