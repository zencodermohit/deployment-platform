# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-split-control-plane-and-build-plane.md) | Split control plane and build plane | Accepted |
| [0003](0003-orchestration-dispatcher-and-reconciler.md) | SQS dispatcher + EventBridge reconciler | Accepted |
| [0004](0004-control-plane-fetches-source.md) | Control plane fetches source; container gets no GitHub token | Accepted |
| [0005](0005-edge-routing-cloudfront-function-kvs.md) | Edge routing via CloudFront Function + KeyValueStore | Accepted |
| [0006](0006-static-only-mvp.md) | Static output only in the MVP | Accepted |
| [0007](0007-public-subnet-no-nat.md) | Public subnet, no NAT Gateway | Accepted |
| [0008](0008-dynamodb-single-table.md) | Single-table DynamoDB with a sparse in-flight index | Accepted |
| [0009](0009-container-reports-via-scoped-api.md) | Container reports status via scoped API, not DynamoDB | Accepted |

## Template

```markdown
# ADR-NNNN: <decision in the imperative>

**Status:** Proposed | Accepted | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD

## Context
What forces are at play? What makes this decision necessary and non-obvious?

## Decision
What we are doing, stated actively.

## Consequences
What becomes easier, what becomes harder, what we now have to live with.
Include the bad consequences - an ADR with only upsides is marketing.

## Alternatives considered
What else was on the table and why it lost. This is the most valuable section.
```
