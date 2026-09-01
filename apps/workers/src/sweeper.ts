/**
 * Sweeper — scheduled, every five minutes.
 *
 * The reconciler catches tasks that stop. This catches everything that leaves
 * no trace at all: a task that vanishes without an event, a dispatcher that
 * died between claiming and launching, an EventBridge delivery that was lost.
 *
 * It reads the SPARSE in-flight index, so its cost is proportional to the
 * number of live deployments — a handful — rather than to the whole deployment
 * history. That is the entire reason gsi2 exists (ADR-0008), and why forgetting
 * to REMOVE those keys on a terminal transition would be so expensive: every
 * leaked item would be re-examined every five minutes, forever.
 */

import {
  failDeployment,
  findOverdueDeployments,
  getDeploymentConsistent,
} from '@platform/data';
import { isTerminal } from '@platform/core';
import { log } from './shared.js';

export async function handler(): Promise<{ examined: number; failed: number }> {
  const overdue = await findOverdueDeployments(new Date());

  if (overdue.length === 0) {
    log('debug', 'nothing overdue');
    return { examined: 0, failed: 0 };
  }

  log('info', 'found overdue deployments', { count: overdue.length });

  let failed = 0;
  for (const candidate of overdue) {
    // The index is a GSI, and GSI reads are ALWAYS eventually consistent — a
    // deployment that finished moments ago can still appear here. Re-read the
    // base item strongly before acting, or the sweeper will occasionally
    // "fail" builds that actually succeeded.
    const deployment = await getDeploymentConsistent(
      candidate.projectId,
      candidate.createdAt,
      candidate.deploymentId,
    );

    if (!deployment) {
      log('warn', 'overdue entry has no base item', { deploymentId: candidate.deploymentId });
      continue;
    }

    if (isTerminal(deployment.status)) {
      log('debug', 'already finished; the index was simply stale', {
        deploymentId: deployment.deploymentId,
        status: deployment.status,
      });
      continue;
    }

    const result = await failDeployment(deployment, 'sweeper', {
      code: 'TIMEOUT',
      message: `the deployment passed its deadline of ${deployment.deadlineAt} while still ${deployment.status}`,
    });

    if (result.won) {
      failed += 1;
      log('info', 'swept a stuck deployment', {
        deploymentId: deployment.deploymentId,
        stuckAt: deployment.status,
        deadlineAt: deployment.deadlineAt,
      });
    }
  }

  return { examined: overdue.length, failed };
}
