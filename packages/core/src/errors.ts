/**
 * Exit codes and the single error type the builder throws.
 *
 * The exit code is the ONLY thing that survives a container dying, so it is the
 * contract between the build plane and the control plane. See docs/04-build-contract.md.
 */

export const EXIT = {
  OK: 0,
  SOURCE_ERROR: 10,
  UNSUPPORTED_FRAMEWORK: 11,
  INSTALL_FAILED: 12,
  BUILD_FAILED: 13,
  NO_OUTPUT: 14,
  ARTIFACT_TOO_LARGE: 15,
  PUBLISH_FAILED: 16,
  TIMEOUT: 17,
  /** Bad or missing environment configuration. Added in M1; not in the original table. */
  CONFIG_ERROR: 20,
  /** A bug in the builder itself, not a fault in the user's repository. */
  INTERNAL: 70,
} as const;

export type FailureCode = Exclude<keyof typeof EXIT, 'OK'>;

/** SIGKILL. Set by the kernel OOM killer; the container cannot report this itself. */
export const EXIT_SIGKILL = 137;

export class BuildError extends Error {
  readonly code: FailureCode;
  readonly detail: Record<string, unknown>;

  constructor(code: FailureCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.detail = detail;
  }

  get exitCode(): number {
    return EXIT[this.code];
  }

  /** True when the user's repository caused this, false when the platform did. */
  get isUserFault(): boolean {
    return this.code !== 'INTERNAL' && this.code !== 'CONFIG_ERROR';
  }
}

export function isBuildError(e: unknown): e is BuildError {
  return e instanceof BuildError;
}

/** Wrap anything thrown into a BuildError so the exit code is always deliberate. */
export function toBuildError(e: unknown, fallback: FailureCode = 'INTERNAL'): BuildError {
  if (isBuildError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new BuildError(fallback, message);
}
