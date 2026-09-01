# ADR-0009: The build container reports status through a scoped API, not DynamoDB

**Status:** Accepted | **Date:** 2026-09-01

## Context

The build container must report progress: `PROVISIONING -> BUILDING -> UPLOADING -> DEPLOYED`, plus
failures. The obvious implementation is to give the ECS task role `dynamodb:UpdateItem` on the
deployment record.

That grants the **untrusted** plane write access to the control plane's source of truth. IAM can
narrow it somewhat - `dynamodb:LeadingKeys` scopes access to a partition key - but the deployment
partition is `PROJECT#<id>`, so the container would gain write access to **every deployment record
in that project**, including ones it has nothing to do with. A compromised build could mark another
deployment `DEPLOYED`, or rewrite its `artifactPrefix` to point at attacker-controlled content.

Getting IAM to scope a write to exactly one item is awkward at best, and "awkward IAM protecting a
trust boundary" is precisely the kind of thing that is subtly wrong in production.

## Decision

The container holds **no DynamoDB permissions at all**. It reports status by calling:

```
POST /internal/deployments/{deploymentId}/status
Authorization: Bearer <STATUS_TOKEN>
```

`STATUS_TOKEN` is 256 bits of randomness, minted by the dispatcher, stored **hashed** on the
deployment record, passed to the container via task overrides, scoped to exactly one deployment,
and expiring at `deadlineAt`. The handler applies the same guarded state transition every other
writer uses.

The complete task role becomes:

```
s3:PutObject      -> the deployment's own artifact prefix
logs:PutLogEvents -> the deployment's own log stream
(nothing else)
```

The control plane, not the container, writes the CloudFront KeyValueStore on `DEPLOYED`.

## Consequences

- The untrusted plane has **zero** write access to control-plane state. The trust boundary becomes
  trivial to describe, which is worth more than the code it costs.
- State transition validation lives in exactly one place, applied identically to the container, the
  reconciler and the sweeper.
- A stolen `STATUS_TOKEN` lets an attacker forge status for **their own** deployment only, which
  they already control by definition. The blast radius is nil.
- Cost: one extra Lambda invocation per transition (four per build) and an HTTP dependency in the
  container. Both negligible.
- The endpoint must not leak: it takes a `deploymentId` in the path, so it must verify the token
  hash matches *that* deployment's record, not merely that the token is valid.
- The token must be redacted from all build logs. Build tools print their environment more often
  than expected.

## Alternatives considered

- **`dynamodb:UpdateItem` with a `LeadingKeys` condition.** Rejected: scopes to the project
  partition, not the item, so cross-deployment tampering within a project stays possible.
- **Restructuring the table so each deployment is its own partition.** Would make item-level IAM
  work, but breaks the "list deployments for a project" query that
  [ADR-0008](0008-dynamodb-single-table.md) is built around. Wrong trade.
- **Container writes status to SQS; a Lambda applies it.** Equivalent isolation, but adds a queue,
  loses the synchronous error response, and makes ordering something to reason about.
- **Infer all status from EventBridge task events only.** No container reporting at all, but ECS
  events cannot distinguish "installing" from "building", and the phase detail is most of what
  makes the deployment timeline useful.
