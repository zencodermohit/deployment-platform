# 01 — Architecture

This document specifies **mechanism**, not intent. Every arrow names the AWS API call or component
that makes it happen. Where the original design said "and then the build is orchestrated," this
says which Lambda calls which API with what arguments.

## 1. The trust boundary

There is exactly one security boundary in this system, and everything else is arranged around it.

```
        TRUSTED - CONTROL PLANE                    UNTRUSTED - BUILD PLANE
 +-------------------------------------+  ||  +-------------------------------+
 | API Gateway, Lambda                 |  ||  | Fargate task                  |
 | DynamoDB (state, source of truth)   |  ||  |  +- user's repository         |
 | SQS + DLQ                           |  ||  |  +- npm install (postinstall) |
 | GitHub App credentials              |  ||  |  +- npm run build             |
 | CloudFront KeyValueStore            |  ||  |                               |
 | Source-tarball fetcher              |  ||  |  no GitHub token              |
 |                                     |  ||  |  no DB access                 |
 |                                     |  ||  |  write to ONE S3 prefix       |
 +-------------------------------------+  ||  +-------------------------------+
                                          ||
                         the boundary. nothing trusted crosses it.
```

The build plane's isolation does not come from firewall rules. It comes from **the task having
nothing worth reaching and no credential worth stealing**. Assume the container is fully
compromised on every build, then ask what the attacker gets. The answer must be: a shell in a
throwaway sandbox with write access to one S3 prefix that is about to be sealed.

## 2. Component inventory

| Component | Service | Responsibility |
|---|---|---|
| Dashboard | S3 + CloudFront | React SPA |
| Public API | API Gateway (HTTP API) + Lambda | Auth, projects, deployments, logs |
| State store | DynamoDB, single table | Source of truth for all entities |
| Job queue | SQS + DLQ | Decouples request from build |
| **Dispatcher** | Lambda (SQS-triggered) | Claims the deployment, calls `ecs:RunTask` |
| **Source fetcher** | Lambda | Downloads repo tarball via GitHub App, writes to S3 |
| Build runner | ECS Fargate task | Untrusted build execution |
| **Reconciler** | Lambda (EventBridge-triggered) | Detects tasks that died without reporting |
| **Sweeper** | Lambda (scheduled, 5 min) | Fails deployments stuck past their deadline |
| Artifacts | S3, immutable prefixes | Built output |
| Edge router | CloudFront Function + KeyValueStore | Host to S3-prefix rewrite |
| Delivery | CloudFront + OAC to S3 | TLS, caching, global delivery |

The four bolded components are the ones the original design did not name. They are where the real
engineering is. "Build Orchestrator" was a box with nothing in it; these four are what goes inside.

## 3. Deployment sequence

```
 1. POST /projects/{id}/deployments
      |
 2.   +- Lambda: authz (project.ownerId == caller), validate body
      +- Lambda: resolve branch -> commit SHA via GitHub App (trusted side)
      +- Lambda: DynamoDB PutItem, status=QUEUED, ConditionExpression on non-existence
      +- Lambda: SQS SendMessage { deploymentId }
      +- 202 Accepted { deploymentId, status: "QUEUED" }      ~200ms, returns immediately

 3. SQS -> Dispatcher Lambda
      |
      +- DynamoDB UpdateItem  QUEUED -> PROVISIONING  [Condition: status = QUEUED]
      |    +- condition fails? another worker owns it.
      |       delete message, exit clean.                     <-- IDEMPOTENCY
      +- invoke source fetcher: GitHub tarball -> s3://sources/{deploymentId}.tar.gz
      +- generate presigned GET URL for that object (15 min TTL)
      +- ecs:RunTask - overrides carry deploymentId, artifact prefix, presigned source URL
      +- DynamoDB UpdateItem: store taskArn.  Delete SQS message.

 4. Fargate task starts                                       ~30-60s cold start
      +- PROVISIONING -> BUILDING
      +- download + extract source from presigned URL
      +- detect framework, enforce limits, npm ci, npm run build
      +- BUILDING -> UPLOADING
      +- upload output dir -> s3://artifacts/projects/{p}/deployments/{d}/
      +- UPLOADING -> DEPLOYED  (via status API; control plane writes CloudFront KVS)
      +- task exits, container destroyed

 5. In parallel: EventBridge "ECS Task State Change" -> Reconciler Lambda
      +- task STOPPED but deployment not terminal? -> FAILED, reason from stopCode/exitCode
```

### Why the source fetcher exists

The container never receives a GitHub token. If it cloned the repo itself it would need one, and a
malicious `preinstall` would exfiltrate it in milliseconds, giving an attacker read access to
every repository the installation covers. Instead the **trusted** side fetches
`GET /repos/{owner}/{repo}/tarball/{sha}` with a short-lived GitHub App installation token and
hands the container a presigned S3 URL that expires in 15 minutes and grants nothing else.

This follows directly from your own "treat the repository as hostile" principle. Cloning inside
the container quietly violates it. See [ADR-0004](adr/0004-control-plane-fetches-source.md).

## 4. The retry problem

**The dispatcher deletes the SQS message as soon as `RunTask` succeeds.** The build fails ten
minutes later, long after the message is gone. Therefore:

> SQS retries cover **dispatch** failures. They do **not** cover build failures.

This is the single most common misunderstanding in this architecture, and the original design's
failure diagram assumed recovery it does not actually have. Two separate mechanisms:

| Failure | Recovered by |
|---|---|
| Dispatcher throws, `RunTask` throttled, Lambda OOM | SQS visibility timeout, redelivery, DLQ after 3 attempts |
| Build exits non-zero, times out, container OOM-killed | **Not automatic.** Terminal `FAILED`. User clicks Retry, creating a *new* deployment. |
| Task killed before reporting (placement failure, spot reclaim) | Reconciler, via EventBridge |
| Task hangs, never emits an event | Sweeper, past `deadlineAt` |

Automatic build retry is deliberately **not** implemented. A failing build usually fails
deterministically; retrying burns credits to reach the same answer. Retry is a user action that
creates a new, separately tracked deployment, which is also better UX because the failed attempt
stays visible in history.

## 5. Edge routing - the part that is easy to underestimate

CloudFront has no idea what a deployment is. Mapping `dep-abc123.example.com` to
`s3://artifacts/projects/p-1/deployments/dep-abc123/` requires an explicit rewrite.

```
GET https://dep-abc123.example.com/about/
        |
        v
CloudFront Function  (viewer-request, sub-ms, NO network calls allowed)
        +- read Host header -> "dep-abc123.example.com"
        +- KeyValueStore.get(host) -> "projects/p-1/deployments/dep-abc123"
        +- URI ends in "/" or has no extension? -> append "index.html"
        +- rewrite URI -> "/projects/p-1/deployments/dep-abc123/about/index.html"
        |
        v
S3 origin (REST endpoint + Origin Access Control; bucket stays fully private)
```

Three traps, all of which will bite on day one if not handled:

1. **S3 REST origins do not serve directory indexes.** `GET /about/` returns 403, not
   `about/index.html`. The S3 *website* endpoint does handle this, but it is HTTP-only and requires
   a public bucket, which is unacceptable. The CloudFront Function must append `index.html` itself.
2. **SPA fallback cannot use a CloudFront custom error response.** An earlier
   draft of this document said to map 403/404 to `/index.html` with status 200. That is wrong
   here: `response_page_path` is a single fixed path with no access to the request, so it cannot
   carry a per-deployment prefix — it would serve *some other deployment's* `index.html` to every
   404. Correct approach: store a per-deployment `spa` flag in the KeyValueStore, and have the
   function send extensionless paths straight to that deployment's own `index.html`. Custom error
   responses are still used, but only to turn S3's 403-for-a-missing-key into a plain 404.
3. **Wildcard certificates are single-level.** `*.example.com` covers `dep-abc.example.com` but
   **not** `dep-abc.preview.example.com`. The subdomain scheme must stay one level deep.

CloudFront Functions cannot call DynamoDB; they have no network access at all. KeyValueStore is the
only option that keeps this at sub-millisecond edge latency. Lambda@Edge could query DynamoDB but
adds 30-80ms to *every* asset request.
See [ADR-0005](adr/0005-edge-routing-cloudfront-function-kvs.md).

### Where the "active deployment" pointer lives

DynamoDB is the source of truth. The KeyValueStore is a **materialized read replica for the edge**.
The original design said rollback "changes the active deployment pointer" without ever saying where
that pointer lives. It lives in both places, and the ordering matters.

Promotion and rollback are the same operation:

```
promote(projectId, deploymentId):
  1. verify deployment belongs to project and status == DEPLOYED
  2. DynamoDB:  DOMAIN#<host> -> activeDeploymentId, artifactPrefix   (source of truth)
  3. CloudFront KVS: PutKey(host, artifactPrefix)                     (edge replica)
  4. no invalidation needed - the prefix changed, so the cache keys changed
```

Step 4 is the payoff of immutability: because artifacts live at unique paths and are never
overwritten, **there is never a cache invalidation**. Rollback is instant and free.

If step 3 fails after step 2, the edge is stale. The sweeper reconciles KVS against DynamoDB using
the `kvsSyncedAt` field. This is a real distributed-systems consideration and should be stated
rather than hidden.

## 6. State machine

```
   QUEUED ---> PROVISIONING ---> BUILDING ---> UPLOADING ---> DEPLOYED
      |             |               |              |
      +-------------+---------------+--------------+-------------> FAILED
      |
      +---> CANCELLED
```

`PROVISIONING` is a real state, not bookkeeping: Fargate cold start is 30-60 seconds, and without
it the UI shows "queued" while the user watches nothing happen for a minute.

Every transition is a DynamoDB `UpdateItem` with a `ConditionExpression` on the current status.
Invalid transitions fail at the database, not in application code.

| From | To | Written by | Guard |
|---|---|---|---|
| (none) | QUEUED | API Lambda | `attribute_not_exists(PK)` |
| QUEUED | PROVISIONING | Dispatcher | `status = QUEUED` <- **the claim** |
| PROVISIONING | BUILDING | Container (via status API) | `status = PROVISIONING` |
| BUILDING | UPLOADING | Container (via status API) | `status = BUILDING` |
| UPLOADING | DEPLOYED | Container (via status API) | `status = UPLOADING` |
| any non-terminal | FAILED | Container / Reconciler / Sweeper | `status IN (...)` |
| QUEUED, PROVISIONING | CANCELLED | API Lambda | `status IN (QUEUED, PROVISIONING)` |

**Idempotency in one sentence:** the `QUEUED -> PROVISIONING` conditional update *is* the claim, and
DynamoDB guarantees exactly one writer wins it. A duplicate SQS delivery loses the condition,
deletes its message, and exits without launching anything.

Note that the claim happens in the **dispatcher**, before `RunTask`. Claiming inside the container
would be too late: two containers would already be running.

## 7. Failure taxonomy

| Failure | Detected by | Result |
|---|---|---|
| Invalid repo URL / unsupported framework | API validation (Zod) | 400, no deployment created |
| Repo too large | Source fetcher checks `Content-Length` | `FAILED`, clear message |
| `npm ci` fails | Container exit code | `FAILED` + logs |
| Build exceeds 10 min | In-container watchdog **and** external `StopTask` | `FAILED` (timeout) |
| Container OOM-killed | EventBridge to Reconciler (`exitCode 137`) | `FAILED` (out of memory) |
| Output dir missing or empty | Container validation before upload | `FAILED` |
| Artifact exceeds size cap | Container validation | `FAILED` |
| Fargate capacity / placement failure | EventBridge to Reconciler | `FAILED` |
| Dispatcher crash | SQS redelivery, then DLQ | Alarm on DLQ depth > 0 |
| Task vanishes silently | Sweeper, past `deadlineAt` | `FAILED` |

**Fargate has no task timeout setting.** This is worth stating plainly because it looks like it
should be one. Timeouts are enforced twice: a watchdog inside the container (self-terminates on
schedule), and an external `StopTask`, because a wedged container will not kill itself.

Related correction: Fargate ephemeral storage has a **20 GiB floor**. You cannot configure it
lower, so "limit ephemeral disk" is enforced by the container checking its own usage, not by task
configuration.

## 8. Networking

Always-on topology, chosen for cost. See [ADR-0007](adr/0007-public-subnet-no-nat.md).

- Build tasks run in a **public subnet** with `assignPublicIp: ENABLED`.
- Security group: **zero inbound rules**; egress 443/80 only.
- **Gateway** VPC endpoints for S3 and DynamoDB. Free, and they keep artifact traffic off the IGW.
- **No** interface endpoints (~$7.20/mo each; four of them cost more than the NAT being avoided).
- **No** NAT Gateway (~$32/mo).

A public IP with no inbound rules is not "exposed" - nothing can initiate a connection to it. The
build subnet has no route to anything internal because there *is* nothing internal: the control
plane is entirely serverless and reachable only over authenticated public APIs.

**Honest limitation:** egress is unrestricted. Restricting it to npm and GitHub requires an egress
proxy you operate, or AWS Network Firewall at roughly $300/month. The mitigation is that outbound
access buys an attacker nothing, because there is no credential in the container worth
exfiltrating. State this directly rather than drawing a diagram with X marks that the
implementation does not enforce.

> **Tier B demonstration.** The private-subnet + NAT + interface-endpoint topology is written in
> Terraform behind `var.network_mode = "private"`. Stand it up for a few days, capture VPC Flow
> Logs and the working architecture, then destroy it. NAT is $32/month but only **$1.05/day**.
> The Terraform is the proof of competence; it does not have to stay running.

## 9. Observability

- **Logs.** Build container to the `awslogs` driver, one CloudWatch log stream per deployment. The
  API reads via `FilterLogEvents`; the UI polls every 2s while the deployment is non-terminal. Log
  lines are structured JSON carrying `deploymentId`, `phase`, `level`, `ts`.
- **Metrics.** EMF (Embedded Metric Format) from Lambda and the container, so metrics cost no extra
  API calls. Track `BuildDuration` (p50/p95), `DeploymentOutcome` by status, `QueueDepth`,
  `DispatchLatency`, `ProvisioningLatency`, `ArtifactBytes`, `DLQDepth`.
- **Tracing.** X-Ray across API Gateway to Lambda to SQS to Dispatcher. The ECS segment must be
  stitched manually by passing the trace header through task overrides. Worth doing; that hop is
  the interesting part of the trace.
- **Alarms.** DLQ depth > 0; deployment failure rate > 30% over 15 minutes; concurrent task count
  above the cap; and **AWS Budgets at 50/80/100%** of the credit pool.
