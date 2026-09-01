# 02 — Data Model

Access patterns first. The table design follows from them; the reverse never works in DynamoDB.

## Access patterns

| # | Pattern | Used by |
|---|---|---|
| A1 | Get user by id | Auth middleware |
| A2 | Get user by email | Login |
| A3 | List projects for a user | Dashboard |
| A4 | Get project by id (+ owner, for authz) | Every project route |
| A5 | Create deployment | `POST /deployments` |
| A6 | Get deployment by id | Status polling |
| A7 | List deployments for a project, newest first, paginated | Project page |
| A8 | **Claim** a deployment (conditional status transition) | Dispatcher |
| A9 | Transition deployment status | Container, reconciler |
| A10 | Find in-flight deployments older than a deadline | Sweeper |
| A11 | Resolve hostname → active artifact prefix | API, KVS reconciliation |
| A12 | Set active deployment for a hostname | Promote / rollback |
| A13 | Count a user's in-flight deployments | Quota enforcement |

## Table

Single table, `platform`. On-demand billing. PITR on. Encrypted with a customer-managed KMS key.

| Entity | PK | SK | GSI1PK | GSI1SK | GSI2PK | GSI2SK |
|---|---|---|---|---|---|---|
| User | `USER#<userId>` | `PROFILE` | `EMAIL#<email>` | `USER` | — | — |
| Project | `USER#<userId>` | `PROJECT#<projectId>` | `PROJECT#<projectId>` | `META` | — | — |
| Deployment | `PROJECT#<projectId>` | `DEP#<createdAt>#<deploymentId>` | `DEP#<deploymentId>` | `META` | `INFLIGHT` | `<deadlineAt>` |
| Domain | `DOMAIN#<hostname>` | `META` | — | — | — | — |
| Quota counter | `USER#<userId>` | `QUOTA` | — | — | — | — |

**GSI1 — `by-id`.** Entities are addressed by opaque id from the API, but stored under their parent
for list queries. GSI1 provides the id lookup. Projection: `ALL`.

**GSI2 — `in-flight`, sparse.** `GSI2PK` is written **only** while a deployment is non-terminal, and
**removed** (`REMOVE gsi2pk, gsi2sk`) on every transition to a terminal state. The index therefore
contains only live builds — usually a handful of items. The sweeper queries
`GSI2PK = "INFLIGHT" AND GSI2SK < now`, which is O(stuck deployments), not O(all deployments).
Projection: `KEYS_ONLY` plus `status`, `taskArn`.

A sparse GSI is the right tool here and is worth calling out in an interview — the naive
alternative is scanning the table on a schedule, which grows without bound.

### Why `DEP#<createdAt>#<deploymentId>`

The sort key embeds an ISO-8601 timestamp so that `Query(PK = PROJECT#x, ScanIndexForward = false)`
returns deployments newest-first with no sorting, no filtering, and no extra index. The
`deploymentId` suffix breaks ties for deployments created in the same millisecond.
`LastEvaluatedKey` gives free cursor pagination.

## Item shapes

```jsonc
// Deployment
{
  "PK": "PROJECT#prj_7f3a", "SK": "DEP#2026-09-01T10:00:00.000Z#dep_9c21",
  "gsi1pk": "DEP#dep_9c21", "gsi1sk": "META",
  "gsi2pk": "INFLIGHT", "gsi2sk": "2026-09-01T10:12:00.000Z",  // removed when terminal

  "entity": "Deployment",
  "deploymentId": "dep_9c21", "projectId": "prj_7f3a", "userId": "usr_1a4b",
  "status": "BUILDING",
  "repositoryUrl": "https://github.com/octocat/hello-world",
  "branch": "main", "commitSha": "abc123...", "commitMessage": "fix nav",
  "trigger": "manual",                       // manual | webhook | retry
  "framework": "vite",
  "artifactPrefix": "projects/prj_7f3a/deployments/dep_9c21/",
  "hostname": "dep-9c21.example.com",
  "taskArn": "arn:aws:ecs:...:task/...",     // written by dispatcher, used by reconciler
  "logStreamName": "builds/dep_9c21",
  "createdAt": "...", "startedAt": "...", "finishedAt": null,
  "deadlineAt": "2026-09-01T10:12:00.000Z",  // createdAt + 12min; drives the sweeper
  "durationMs": null,
  "artifactBytes": null, "fileCount": null,
  "error": null,                             // { code, message, exitCode }
  "retryOfDeploymentId": null,
  "schemaVersion": 1
}

// Domain — the active-deployment pointer, source of truth
{
  "PK": "DOMAIN#myblog.example.com", "SK": "META",
  "entity": "Domain",
  "hostname": "myblog.example.com",
  "projectId": "prj_7f3a",
  "activeDeploymentId": "dep_9c21",
  "artifactPrefix": "projects/prj_7f3a/deployments/dep_9c21/",
  "previousDeploymentId": "dep_8b11",        // makes one-click rollback trivial
  "kvsSyncedAt": "2026-09-01T10:02:20.000Z", // lets the sweeper detect edge drift
  "updatedAt": "..."
}
```

## The critical writes

**A8 — claim (idempotency).** Exactly one dispatcher can win this. A duplicate SQS delivery gets
`ConditionalCheckFailedException`, deletes its message, and exits without launching a task.

```
UpdateItem
  Key: { PK: "PROJECT#prj_7f3a", SK: "DEP#...#dep_9c21" }
  UpdateExpression:    SET #s = :provisioning, startedAt = :now, taskArn = :arn
  ConditionExpression: #s = :queued
```

**A9 — terminal transition.** Note the `REMOVE`, which is what keeps GSI2 sparse.

```
UpdateItem
  UpdateExpression:    SET #s = :deployed, finishedAt = :now, durationMs = :d
                       REMOVE gsi2pk, gsi2sk
  ConditionExpression: #s = :uploading
```

**A13 — quota.** Atomic counter on the user item, incremented on create and decremented on terminal
transition, guarded so it cannot exceed the cap. This is the primary defence against a runaway
credit burn.

```
UpdateExpression:    SET inFlight = inFlight + :one
ConditionExpression: inFlight < :maxConcurrent
```

## Consistency notes

- Reads for authorization use `ConsistentRead: true`. A stale read here is a security bug.
- Reads for the dashboard are eventually consistent. Half a second of staleness is fine.
- GSI reads are **always** eventually consistent — DynamoDB offers no choice. The sweeper must
  therefore tolerate seeing a deployment that has just gone terminal, and re-checks the base item
  with a consistent read before acting on it.
- S3 artifact prefixes are never reused, so there is no read-after-overwrite hazard.

## What is deliberately not stored here

- **Build logs.** CloudWatch Logs, referenced by `logStreamName`. Putting log text in DynamoDB
  would blow the 400KB item limit and cost far more per byte.
- **Artifacts.** S3, referenced by `artifactPrefix`.
- **Secrets.** Secrets Manager (GitHub App private key) and SSM Parameter Store (non-secret config).
