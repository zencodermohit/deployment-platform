# ADR-0005: Route deployments at the edge with a CloudFront Function and KeyValueStore

**Status:** Accepted | **Date:** 2026-09-01

## Context

`dep-abc123.example.com` must serve `s3://artifacts/projects/p-1/deployments/dep-abc123/`.
CloudFront has no concept of a deployment and cannot perform that mapping on its own. The original
design drew an arrow from CloudFront to S3 and left the mapping unspecified - it is in fact one of
the harder parts of the system.

Three separate problems are tangled together:

1. Host to S3-prefix lookup, on every request, without adding meaningful latency.
2. S3 REST origins do not serve directory index documents. `GET /about/` returns 403, not
   `about/index.html`.
3. SPA client-side routes need unknown paths to return `index.html` with status 200.

## Decision

A **CloudFront Function** on viewer-request that:

- reads the `Host` header,
- looks the hostname up in a **CloudFront KeyValueStore** to get the artifact prefix,
- appends `index.html` when the URI ends in `/` or has no file extension,
- rewrites the URI to `<prefix>/<path>`.

Plus a CloudFront **custom error response** mapping 403/404 to `/index.html` with status 200, for
SPA fallback. Origin is the S3 REST endpoint with Origin Access Control; the bucket stays private.

DynamoDB remains the source of truth for the host-to-deployment mapping. The KeyValueStore is a
**materialized read replica for the edge**, written by the control plane on promote/rollback and
reconciled by the sweeper via the `kvsSyncedAt` field.

## Consequences

- Sub-millisecond routing, no origin round-trip for the lookup, no per-request cost of note
  (2M free invocations/month).
- Rollback is a KVS `PutKey`. Because prefixes are immutable and unique, **there is never a cache
  invalidation**. This is the concrete payoff of immutable artifacts.
- The KVS can drift from DynamoDB if the second write fails. Accepted, detected, and repaired by
  the sweeper. Stating this is better than pretending the two writes are atomic.
- CloudFront Functions have real limits: no network calls, no `async`, ~10ms CPU, 10 KB source.
  The routing logic must stay trivial. It does.
- **Wildcard certificates are single-level.** `*.example.com` does not cover
  `dep-abc.preview.example.com`, so the subdomain scheme stays one level deep.

## Alternatives considered

- **Lambda@Edge with a DynamoDB lookup.** Removes the drift problem entirely - one source of truth.
  Rejected: 30-80ms added to *every asset request*, us-east-1-only deployment, replication delays
  on update, and materially higher cost. Wrong tool for a hot path this simple.
- **One CloudFront distribution per deployment.** Rejected: distributions take ~15 minutes to
  deploy, there are account limits, and it makes rollback slow instead of instant.
- **Path-based routing** (`/d/dep-123/...` on one domain). Simpler, no DNS or certificate work, but
  breaks absolute asset paths in most build outputs and loses per-deployment origin isolation.
  Kept as the documented fallback if the domain is unavailable.
- **S3 website endpoint** (which does handle index documents). Rejected: HTTP-only to the origin
  and requires a public bucket.
