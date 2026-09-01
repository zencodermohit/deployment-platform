# ADR-0002: Split the system into a control plane and a build plane

**Status:** Accepted | **Date:** 2026-09-01

## Context

The platform executes build commands from repositories we do not control. `package.json` lifecycle
scripts (`preinstall`, `postinstall`) and the build script itself are arbitrary code, running with
whatever privileges the process that invoked them has.

An earlier iteration ran `npm install` and `npm run build` directly on the API host. That gives any
user of the platform a shell on the infrastructure, with the API's credentials, its network
position, and its database access.

## Decision

Split into two planes with exactly one boundary between them.

**Control plane (trusted):** auth, deployment records, state machine, orchestration, GitHub
credentials, edge configuration. Serverless: API Gateway, Lambda, DynamoDB, SQS.

**Build plane (untrusted):** one ephemeral Fargate task per deployment. Receives a source tarball,
produces artifacts. Holds no credential beyond `s3:PutObject` on a single prefix. Destroyed when
the build ends.

The design assumption is that **every build is a successful compromise**, and the system is
arranged so that this is survivable.

## Consequences

- Nothing trusted crosses the boundary. Everything else in the architecture follows from this.
- Extra latency: Fargate cold start adds 30-60s per deployment. Acceptable; builds take minutes.
- Extra components: the dispatcher, source fetcher, reconciler and sweeper all exist because the
  build no longer runs in-process. This is the real cost of the decision, and it is worth paying.
- Isolation comes from the task having nothing worth reaching, not from network rules. See
  [ADR-0007](0007-public-subnet-no-nat.md).

## Alternatives considered

- **Build on the API host.** Rejected: remote code execution as a product feature.
- **Build in Lambda.** Rejected: 15-minute ceiling, 10 GB `/tmp`, no Docker, and execution
  environments that are reused across invocations.
- **Long-lived build worker on EC2.** Rejected: state persists between builds, so one build can
  poison the next. Ephemerality is the point.
- **AWS CodeBuild.** Genuinely reasonable, and solves isolation for free. Rejected because this
  project exists to demonstrate that the isolation was *designed* rather than bought, and because
  CodeBuild's startup and pricing are worse at this scale.
