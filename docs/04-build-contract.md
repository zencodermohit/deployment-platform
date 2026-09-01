# 04 - Build Contract

The interface between the trusted control plane and the untrusted build container. Both sides are
written against this document, so it must be precise.

## What the container receives

Passed via ECS task `overrides.containerOverrides[0].environment` at `RunTask` time:

| Variable | Example | Notes |
|---|---|---|
| `DEPLOYMENT_ID` | `dep_9c21` | |
| `SOURCE_URL` | `https://...presigned...` | S3 presigned GET, 15 min TTL, single object |
| `ARTIFACT_BUCKET` | `platform-artifacts-prod` | |
| `ARTIFACT_PREFIX` | `projects/prj_7f3a/deployments/dep_9c21/` | Server-generated. Never client-influenced. |
| `STATUS_URL` | `https://api.../internal/deployments/dep_9c21/status` | |
| `STATUS_TOKEN` | opaque, 32 bytes | Scoped to this deployment, expires at `deadlineAt` |
| `BUILD_TIMEOUT_SEC` | `600` | |
| `MAX_ARTIFACT_BYTES` | `524288000` | |

## What the container must NOT have

This list is the security design. It is worth more than the diagram.

- No GitHub token, SSH key, or any GitHub credential.
- No DynamoDB permissions of any kind.
- No SQS permissions.
- No Secrets Manager or SSM permissions.
- No `s3:GetObject` on the artifact bucket (write-only, and only to its own prefix).
- No `s3:DeleteObject` anywhere.
- No ability to read another deployment's artifacts.
- No production database, cache, or internal service to reach - none exist.

Task role IAM policy, in full:

```
s3:PutObject      -> arn:aws:s3:::platform-artifacts-prod/${ARTIFACT_PREFIX}*
logs:PutLogEvents -> the deployment's own log stream
(nothing else)
```

`${ARTIFACT_PREFIX}` is interpolated per task via `RunTask` overrides against a role whose policy
uses a session-scoped condition. The container cannot write outside its own prefix even if fully
compromised. This is what makes the "immutable artifacts" claim actually true rather than
aspirational.

## Phases and exit codes

```
  0. bootstrap    -> report BUILDING, start watchdog
  1. fetch        -> download SOURCE_URL, verify size, extract tarball
  2. inspect      -> read package.json, detect framework, reject if unsupported
  3. install      -> npm ci (or npm install if no lockfile)
  4. build        -> npm run build
  5. collect      -> locate output dir, validate non-empty, check size + file count
  6. upload       -> report UPLOADING, stream to S3
  7. finalize     -> report DEPLOYED
```

| Exit code | Meaning | Reported as |
|---|---|---|
| 0 | Success | `DEPLOYED` |
| 10 | Source fetch or extract failed | `FAILED` / `SOURCE_ERROR` |
| 11 | Unsupported or undetectable framework | `FAILED` / `UNSUPPORTED_FRAMEWORK` |
| 12 | Dependency install failed | `FAILED` / `INSTALL_FAILED` |
| 13 | Build command failed | `FAILED` / `BUILD_FAILED` |
| 14 | Output directory missing or empty | `FAILED` / `NO_OUTPUT` |
| 15 | Artifact exceeds limits | `FAILED` / `ARTIFACT_TOO_LARGE` |
| 16 | Upload failed | `FAILED` / `UPLOAD_FAILED` |
| 17 | Watchdog timeout | `FAILED` / `TIMEOUT` |
| 137 | SIGKILL, almost always OOM | `FAILED` / `OUT_OF_MEMORY` (set by reconciler) |

Exit code 137 cannot be reported by the container, because the container is already dead. The
reconciler reads it from the ECS task state-change event. This is precisely why the reconciler
exists.

## Extraction safety

The tarball comes from GitHub, but treat it as hostile anyway:

- Reject any entry whose normalised path escapes the destination (`../`, absolute paths).
  **Zip-slip is a real and commonly missed vulnerability.**
- Reject symlinks and hardlinks pointing outside the extraction root.
- Enforce a decompressed-size cap while streaming, not after. A 1MB tarball can expand to 100GB.
- Enforce a file-count cap during extraction.
- Strip the single leading directory GitHub adds (`{owner}-{repo}-{sha}/`).

## Build execution

```
npm ci --ignore-scripts=false --no-audit --no-fund
```

Lifecycle scripts run. That is the entire point of the platform, and it is why the container is
disposable. Do not add `--ignore-scripts`: it would break most real projects and would be
security theatre, since `npm run build` executes arbitrary code seconds later regardless.

- Run as a **non-root** user (`USER node`) inside the container.
- `NODE_OPTIONS=--max-old-space-size` set below the task memory limit, so Node throws a catchable
  heap error before the kernel OOM-kills the task and destroys the logs.
- No `shell: true` and no string interpolation of any user-controlled value into a command. Build
  commands come from a fixed table keyed by detected framework, never from `package.json`.

## Artifact rules

- Output directory determined by detected framework (see [00-scope.md](00-scope.md)), never by
  user configuration.
- Upload with bounded concurrency (8 parallel `PutObject` calls), **not** one-by-one and **not**
  unbounded. Streaming, no buffering of whole files in memory.
- `Content-Type` set from file extension. Getting this wrong means the browser downloads your HTML
  instead of rendering it.
- Cache headers on upload:
  - fingerprinted assets (`/assets/*`, hashed filenames): `max-age=31536000, immutable`
  - `*.html`: `max-age=0, must-revalidate`
- Never overwrite an existing object. The prefix is unique per deployment, so this is structurally
  guaranteed rather than checked.

## Log protocol

One JSON object per line to stdout. The `awslogs` driver ships it to CloudWatch.

```json
{"ts":"2026-09-01T10:01:30.221Z","level":"info","phase":"install","msg":"added 214 packages"}
```

- Truncate any single line to 8KB.
- Cap total log volume per build (10MB); after that, log only phase transitions. A malicious repo
  that prints infinite output should not generate an unbounded CloudWatch bill.
- **Redact `STATUS_TOKEN` and `SOURCE_URL` from all output.** Build tools print their environment
  more often than you would expect.

## Limits

| Limit | Value | Enforced where |
|---|---|---|
| Task CPU | 1 vCPU | Task definition |
| Task memory | 2 GB | Task definition |
| Ephemeral storage | 21 GB | Task definition (20 GB is the floor Fargate allows) |
| Source tarball | 100 MB compressed | Source fetcher, before dispatch |
| Extracted source | 500 MB | Streaming check during extraction |
| Build wall clock | 10 min | In-container watchdog + external `StopTask` |
| Artifact size | 500 MB | Before upload |
| Artifact file count | 20,000 | Before upload |
| Log volume | 10 MB | Container |

Two independent timeout mechanisms are required. The watchdog handles a slow build; the external
`StopTask` handles a wedged one that cannot kill itself. Relying on either alone leaves a case
where a task runs until something else notices, which on Fargate means "until you notice the bill".
