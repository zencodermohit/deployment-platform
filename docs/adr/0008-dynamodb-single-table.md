# ADR-0008: Single-table DynamoDB design with a sparse in-flight index

**Status:** Accepted | **Date:** 2026-09-01

## Context

The original design showed a deployment JSON document but no key schema, no indexes, and no access
patterns. In DynamoDB, the access patterns determine the table; designing the table first and
querying it later does not work.

Two queries shape everything: "list deployments for a project, newest first" and "find in-flight
deployments that are past their deadline" (the sweeper).

## Decision

One table, `platform`, on-demand billing, PITR enabled, encrypted with a customer-managed KMS key.
Full schema in [02-data-model.md](../02-data-model.md).

Three design points worth stating:

1. **Deployments are stored under their project** (`PK = PROJECT#<id>`) with a sort key of
   `DEP#<createdAt>#<deploymentId>`. Querying with `ScanIndexForward: false` returns them
   newest-first with no sorting, no filtering, and no extra index. `LastEvaluatedKey` gives free
   cursor pagination.
2. **GSI1 provides lookup by opaque id.** Entities are addressed by id from the API but stored
   under their parent for list queries; GSI1 bridges the two.
3. **GSI2 is a sparse in-flight index.** `gsi2pk = "INFLIGHT"` is written only while a deployment
   is non-terminal and **removed** on every terminal transition. The index therefore contains only
   live builds - typically a handful of items. The sweeper queries
   `GSI2PK = "INFLIGHT" AND GSI2SK < now`, which is O(stuck deployments), not O(all deployments).

## Consequences

- Every access pattern is a `GetItem` or a `Query`. No `Scan` anywhere in the system.
- The sweeper stays cheap forever, regardless of deployment history size. A scheduled table scan -
  the naive alternative - grows without bound and is the kind of thing that quietly becomes the
  largest line on a DynamoDB bill.
- **Every terminal transition must `REMOVE gsi2pk, gsi2sk`.** Forgetting it in one code path leaks
  an item into the sparse index permanently and the sweeper reprocesses it forever. This is the
  most likely bug in the data layer, so it gets a dedicated unit test per transition.
- Authorization reads use `ConsistentRead: true`; a stale read there is a security bug. GSI reads
  are always eventually consistent, so the sweeper re-checks the base item before acting.
- Single-table design is harder to read than one table per entity. Mitigated by typed access
  functions in `packages/core` - no handler builds a key expression by hand.

## Alternatives considered

- **Table per entity.** Simpler to read, but needs cross-table reads for authorization and gives up
  the parent-child query that makes the deployment list a single efficient `Query`.
- **RDS/Postgres.** Genuinely easier for ad-hoc queries and relational integrity. Rejected:
  conditional-write idempotency is the more interesting story here, there is no relational workload
  to justify it, and an idle RDS instance costs ~$15/month against a $100 pool.
- **Scheduled scan instead of a sparse index.** Simpler to write, unbounded in cost, and misses the
  chance to demonstrate that sparse indexes exist.
