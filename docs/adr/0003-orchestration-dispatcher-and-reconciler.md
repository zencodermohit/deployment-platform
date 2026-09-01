# ADR-0003: Orchestrate builds with an SQS dispatcher plus an EventBridge reconciler

**Status:** Accepted | **Date:** 2026-09-01

## Context

The original design contained a box labelled "Build Orchestrator" between SQS and Fargate with
nothing behind it. There is no such AWS service; it has to be built, and the choice is load-bearing.

The core difficulty: a build takes minutes, but nothing in the control plane can block that long.
Lambda cannot hold an SQS message open for a 10-minute Fargate task without paying for the wait and
risking a timeout. So whatever launches the task must return immediately, which means **something
else** has to notice when the task dies without reporting.

## Decision

Three cooperating pieces:

1. **Dispatcher Lambda** (SQS-triggered). Performs the `QUEUED -> PROVISIONING` conditional claim,
   fetches the source, calls `ecs:RunTask`, stores the task ARN, deletes the message. Never waits.
2. **Reconciler Lambda** (EventBridge, on `ECS Task State Change`). When a task reaches `STOPPED`
   while its deployment is still non-terminal, marks it `FAILED` with a reason derived from
   `stopCode` and `exitCode`. This is the only way to catch OOM kills (exit 137), placement
   failures, and external stops.
3. **Sweeper Lambda** (scheduled, 5 min). Queries the sparse `INFLIGHT` GSI for deployments past
   `deadlineAt` and fails them. Catches tasks that vanish without emitting an event, and repairs
   CloudFront KVS drift.

## Consequences

- **SQS retries cover dispatch failures only, not build failures.** The message is gone before the
  build finishes. Stated explicitly in the architecture doc because it is the most common
  misreading of this design.
- Automatic build retry is not implemented. Retry is a user action creating a new deployment.
- The reconciler is the component most likely to have subtle bugs and the hardest to test, so it
  gets explicit deliberate-failure tests.
- Reconciliation is a genuinely senior pattern to have built, and it makes "what happens if the
  container is OOM-killed?" an easy question to answer well.

## Alternatives considered

- **Step Functions with `ecs:runTask.sync`.** Genuinely good: handles waiting, timeouts, retries
  and error branches as configuration, and would remove the reconciler entirely. Rejected for the
  MVP because `.sync` hides exactly the problem worth demonstrating - detecting and reconciling a
  worker that died without reporting. Reconsider later; the cost at this volume is pennies.
- **Long-running ECS service polling SQS.** Rejected: the worker stops being ephemeral, so state
  leaks between builds.
- **Dispatcher waits synchronously.** Rejected: pays Lambda for idle minutes, breaks at 15 minutes.
- **DynamoDB table as the queue** (no SQS). Viable at this scale, and a fair criticism - polling a
  table would work fine here. Rejected because SQS gives visibility timeouts, DLQ, and native
  Lambda triggering for free, and the queue-based story is the more standard one to explain.
