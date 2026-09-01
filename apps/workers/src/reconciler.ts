/**
 * Reconciler — EventBridge, on ECS Task State Change.
 *
 * The reason this exists: the dispatcher launches a task and immediately
 * forgets about it. If that container then dies badly — OOM-killed, stopped by
 * an operator, refused capacity — nobody would ever notice. The deployment sits
 * at BUILDING forever, nothing errors, and the UI just spins. That is the most
 * likely real failure in the whole system and the least visible.
 *
 * So: when a task reaches STOPPED while its deployment is still non-terminal,
 * this fails it and says why.
 *
 * Exit code 137 is the case worth understanding. It means SIGKILL, which on
 * Fargate almost always means the kernel OOM-killer. The container cannot report
 * it, because the container is already gone. This event is the only place that
 * information exists.
 */

import { failDeployment, getDeploymentById } from '@platform/data';
import { isTerminal, type DeploymentStatus } from '@platform/core';
import { log } from './shared.js';

interface TaskStateChangeEvent {
  detail?: {
    taskArn?: string;
    lastStatus?: string;
    stopCode?: string;
    stoppedReason?: string;
    containers?: { name?: string; exitCode?: number | null; reason?: string }[];
    overrides?: {
      containerOverrides?: { environment?: { name?: string; value?: string }[] }[];
    };
  };
}

export async function handler(event: TaskStateChangeEvent): Promise<void> {
  const detail = event.detail;
  if (!detail || detail.lastStatus !== 'STOPPED') return;

  const deploymentId = deploymentIdFrom(detail);
  if (!deploymentId) {
    log('warn', 'stopped task carried no deployment id', { taskArn: detail.taskArn });
    return;
  }

  const deployment = await getDeploymentById(deploymentId);
  if (!deployment) {
    log('warn', 'stopped task refers to an unknown deployment', { deploymentId });
    return;
  }

  // The happy path lands here too, constantly: every successful build also
  // stops its task. The container already reported DEPLOYED, so there is
  // nothing to do — and saying so is cheaper than a conditional write that
  // would fail anyway.
  if (isTerminal(deployment.status as DeploymentStatus)) {
    log('debug', 'task stopped after reporting a terminal state; nothing to do', {
      deploymentId,
      status: deployment.status,
    });
    return;
  }

  const container = detail.containers?.find((c) => c.name === 'builder') ?? detail.containers?.[0];
  const exitCode = container?.exitCode ?? null;
  const { code, message } = explain(exitCode, detail.stopCode, detail.stoppedReason, container?.reason);

  const result = await failDeployment(deployment, 'reconciler', { code, message, exitCode });

  log(result.won ? 'info' : 'debug', result.won ? 'failed a deployment whose task died' : 'lost the race to report failure', {
    deploymentId,
    code,
    exitCode,
    previousStatus: deployment.status,
  });
}

/**
 * The deployment id travels in the task's environment overrides, which the ECS
 * event echoes back. That avoids keeping a task-ARN-to-deployment lookup table
 * whose only job would be to get out of sync.
 */
function deploymentIdFrom(detail: NonNullable<TaskStateChangeEvent['detail']>): string | null {
  for (const override of detail.overrides?.containerOverrides ?? []) {
    for (const variable of override.environment ?? []) {
      if (variable.name === 'DEPLOYMENT_ID' && variable.value) return variable.value;
    }
  }
  return null;
}

function explain(
  exitCode: number | null,
  stopCode: string | undefined,
  stoppedReason: string | undefined,
  containerReason: string | undefined,
): { code: string; message: string } {
  if (exitCode === 137) {
    return {
      code: 'OUT_OF_MEMORY',
      message: 'the build was killed for using too much memory (exit 137)',
    };
  }

  if (exitCode !== null && exitCode !== 0) {
    // A non-zero exit the container failed to report — it died before or during
    // its own status callback.
    return {
      code: 'BUILD_EXITED',
      message: `the build exited with code ${exitCode} without reporting a result`,
    };
  }

  if (stopCode === 'TaskFailedToStart') {
    return {
      code: 'TASK_FAILED_TO_START',
      message: containerReason ?? stoppedReason ?? 'the build container failed to start',
    };
  }

  if (stopCode === 'UserInitiated') {
    // Usually the external half of the timeout: something called StopTask.
    return { code: 'TIMEOUT', message: stoppedReason ?? 'the build was stopped' };
  }

  return {
    code: 'TASK_STOPPED',
    message: stoppedReason ?? 'the build stopped without reporting a result',
  };
}
