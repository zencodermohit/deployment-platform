/**
 * Status reporting from the build container to the control plane.
 *
 * The container holds NO DynamoDB permissions (ADR-0009). It reports progress
 * over HTTP with a per-deployment bearer token that is scoped to one deployment
 * and expires at that deployment's deadline. A stolen token therefore lets an
 * attacker forge status for a build they already control — which is nothing.
 *
 * Reporting is best-effort by design. If the control plane is briefly
 * unreachable the build should still finish and upload; the reconciler and
 * sweeper exist precisely so that a missing report is recoverable. Failing a
 * successful build because a status POST timed out would be the wrong trade.
 */

import type { BuilderConfig, Logger } from '@platform/core';

export type ReportableStatus = 'BUILDING' | 'UPLOADING' | 'DEPLOYED' | 'FAILED';

export interface StatusReport {
  status: ReportableStatus;
  phase?: string;
  framework?: string | null;
  artifactBytes?: number | null;
  fileCount?: number | null;
  error?: { code: string; message: string; exitCode?: number | null } | null;
}

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export interface Reporter {
  report(update: StatusReport): Promise<void>;
}

export function createReporter(cfg: BuilderConfig, log: Logger): Reporter {
  if (cfg.mode === 'local') {
    // Nothing to report to. The final result line in the log is the outcome.
    return { report: async () => {} };
  }

  const { statusUrl, statusToken } = cfg;

  return {
    async report(update: StatusReport): Promise<void> {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          const response = await fetch(statusUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${statusToken}`,
            },
            body: JSON.stringify(update),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });

          if (response.ok) {
            log.debug('status reported', { status: update.status });
            return;
          }

          // 4xx means the control plane rejected this update — a lost race, an
          // expired token, or an illegal transition. Retrying cannot help.
          if (response.status >= 400 && response.status < 500) {
            log.warn('status update rejected', {
              status: update.status,
              httpStatus: response.status,
            });
            return;
          }

          log.warn('status update failed, retrying', {
            httpStatus: response.status,
            attempt,
          });
        } catch (e) {
          log.warn('status update error, retrying', {
            attempt,
            reason: e instanceof Error ? e.message : String(e),
          });
        }

        if (attempt < ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        }
      }

      // Give up quietly. The reconciler will notice if this was the last word.
      log.warn('gave up reporting status', { status: update.status });
    },
  };
}
