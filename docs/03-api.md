# 03 - API Contract

Base URL: `https://api.<domain>` (API Gateway HTTP API).
All requests and responses are `application/json`.

## Conventions

**Auth.** `Authorization: Bearer <sessionToken>`. Sessions are opaque random tokens stored hashed
in DynamoDB, not self-verifying JWTs. Rationale: revocation actually works, and there is no signing
key to leak. At this scale the extra DynamoDB read costs nothing.

**Authorization rule, applied to every project-scoped route.** Load the project with
`ConsistentRead: true`, compare `project.ownerId` to the caller, return **404** (not 403) on
mismatch so the API does not confirm the existence of other users' resources.

**Errors.** One envelope everywhere:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "branch must be a non-empty string",
             "requestId": "req_1a2b3c" } }
```

Codes: `VALIDATION_FAILED` (400), `UNAUTHENTICATED` (401), `NOT_FOUND` (404),
`CONFLICT` (409), `QUOTA_EXCEEDED` (429), `RATE_LIMITED` (429), `INTERNAL` (500).

**Pagination.** `?limit=20&cursor=<opaque>`; response carries `nextCursor` (null when exhausted).
The cursor is a base64 of DynamoDB's `LastEvaluatedKey`, HMAC-signed so clients cannot forge a key
into another partition. Never trust a client-supplied key as a query parameter.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/github/callback` | Exchange OAuth code for a session |
| GET | `/me` | Current user |
| POST | `/projects` | Create project |
| GET | `/projects` | List caller's projects |
| GET | `/projects/{projectId}` | Project detail |
| DELETE | `/projects/{projectId}` | Delete project |
| POST | `/projects/{projectId}/deployments` | **Trigger a deployment** |
| GET | `/projects/{projectId}/deployments` | List deployments, newest first |
| GET | `/deployments/{deploymentId}` | Deployment detail |
| GET | `/deployments/{deploymentId}/logs` | Build logs |
| POST | `/deployments/{deploymentId}/cancel` | Cancel if not yet building |
| POST | `/deployments/{deploymentId}/promote` | **Promote / rollback** |
| POST | `/internal/deployments/{deploymentId}/status` | Build container status callback |

### POST /projects/{projectId}/deployments

```json
// request
{ "branch": "main", "commitSha": null, "idempotencyKey": "cli_2026-09-01_a1b2" }

// 202 Accepted
{ "deploymentId": "dep_9c21", "status": "QUEUED",
  "hostname": "dep-9c21.example.com", "createdAt": "2026-09-01T10:00:00.000Z" }
```

Returns in roughly 200ms. It does **not** wait for the build. If `commitSha` is null the API
resolves the branch head through the GitHub App before creating the record, so the deployment is
pinned to an immutable SHA rather than a moving branch.

`idempotencyKey` is optional and scoped to the project. A repeat within 24h returns the original
`deploymentId` with `200` instead of creating a second deployment. This protects against
double-clicks and client retries, which are far more common than duplicate SQS deliveries.

**Validation** (Zod, rejecting on the first failure):

| Field | Rule |
|---|---|
| `branch` | 1-255 chars, matches `^[\w./-]+$`, no `..`, not starting with `-` |
| `commitSha` | exactly 40 lowercase hex chars, if present |
| `idempotencyKey` | 1-128 chars, `^[\w:-]+$`, if present |

Repository URL is **not** accepted here. It lives on the project, was validated at project
creation, and is read server-side. Accepting it per-deployment would let a caller point an existing
project at an arbitrary repository.

### Repository URL validation (at project creation)

Parse with `new URL()`, never with a regex, then assert every one of:

- protocol is exactly `https:`
- hostname is exactly `github.com` (allowlist, not a suffix match - `github.com.evil.io` fails)
- no `username:password@` in the URL
- path matches `^/[\w.-]+/[\w.-]+(\.git)?$`
- owner and repo contain no `.` or `..` path segments
- the repo is reachable by the caller's GitHub App installation

Store the parsed `owner` and `repo` as separate fields. Never re-parse the raw string later, and
never interpolate it into a shell command.

### GET /deployments/{deploymentId}/logs

```
?since=<ISO timestamp>&limit=500
```

Proxies CloudWatch `FilterLogEvents` for the deployment's log stream. Returns
`{ lines: [{ ts, level, phase, message }], nextSince, complete }`.

The UI polls every 2s while the deployment is non-terminal and stops once `complete` is true.
Polling beats WebSockets here: builds are short, there is no API Gateway WebSocket connection to
manage, and it costs nothing at this scale.

### POST /deployments/{deploymentId}/promote

```json
{ "hostname": "myblog.example.com" }
```

Rollback and promote are the same operation. Requires `status == DEPLOYED`. Writes the DynamoDB
`DOMAIN#` item, then the CloudFront KeyValueStore. No rebuild, no cache invalidation.

### POST /internal/deployments/{deploymentId}/status

Called by the build container. **Not** authenticated with a session token: it carries a
per-deployment bearer token minted at dispatch, stored hashed on the deployment record, valid only
for that one deployment and only until `deadlineAt`.

```json
{ "status": "BUILDING", "phase": "install", "framework": "vite",
  "artifactBytes": null, "error": null }
```

The handler applies the guarded state transition from
[01-architecture.md](01-architecture.md#6-state-machine). This exists so the container needs
**zero** DynamoDB permissions. See [ADR-0009](adr/0009-container-reports-via-scoped-api.md).

## Rate limits and quotas

| Limit | Value | Enforced by |
|---|---|---|
| API requests | 20/s burst, 5/s sustained per session | API Gateway throttling |
| Concurrent deployments per user | 2 | DynamoDB conditional counter |
| Deployments per user per day | 50 | DynamoDB counter with TTL reset |
| Projects per user | 10 | Count check on create |

The concurrency cap is not a politeness feature. It is the primary bound on how fast a malicious
repository can burn AWS credits.
