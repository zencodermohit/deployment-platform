# 11 — M3 Walkthrough (plain English)

M3 gives the platform a **memory** and a **front door**. It is applied and live.

## What changed

Before M3, deploying meant running three commands yourself. Nothing recorded
that it happened, and there was no way to ask "what deployments exist?" because
nothing was writing that down.

Now there is an API you can talk to:

```bash
curl -X POST https://66y53za7pf.execute-api.ap-south-1.amazonaws.com/projects \
  -H 'content-type: application/json' \
  -d '{"name":"my blog","repositoryUrl":"https://github.com/octocat/hello-world"}'
```

```json
{ "projectId": "prj_2111b225…", "repositoryUrl": "https://github.com/octocat/hello-world",
  "defaultBranch": "main", "activeDeploymentId": null }
```

And you can ask it to deploy:

```json
{ "deploymentId": "dep_06764beb…", "status": "QUEUED", "branch": "main",
  "url": "https://d3895jyfnxjrwh.cloudfront.net/d/dep_06764beb…/" }
```

**Nothing builds yet.** The front desk takes your order; the kitchen isn't
wired up until M4. `QUEUED` is honest — it means "recorded, waiting".

## The four ideas worth understanding

### 1. The state machine is one table, and the database enforces it

A deployment can go `QUEUED → PROVISIONING → BUILDING → UPLOADING → DEPLOYED`.
It can never skip a step or go backwards.

That rule lives in **one place** — a list of allowed moves. The API, the
dispatcher, the build container, and the recovery workers all read it. And the
database instruction we send is *generated from that same list*, so an illegal
move is refused by DynamoDB even if the code asking for it has a bug.

It's tested with all **49 combinations** of before-and-after state, driven from
the table itself. Adding a move automatically widens what's allowed; forgetting
to think about one doesn't quietly pass.

### 2. "Exactly one winner" — the idea the whole platform rests on

Queues can deliver the same message twice. That is normal and unavoidable. If
two workers both act on it, you get two builds, two containers, double the cost,
and two writers fighting over one record.

The fix is a **conditional write**: *"change this to PROVISIONING, but only if it
is currently QUEUED."* Two workers try. The database lets one through and tells
the other no. The loser deletes its message and exits quietly — losing is a
normal outcome, not an error.

**This is proved, not assumed.** Ten dispatchers fire at the same deployment
simultaneously, against real DynamoDB. Exactly one wins, every time.

Deliberately not LocalStack. LocalStack *reimplements* conditional writes, so
passing there would prove the reimplementation works — not that our idempotency
does. For this one claim, the real service is the only meaningful test.

### 3. Not yours and not there look identical

Ask for someone else's project and you get **404**, not 403.

A 403 would say "this exists, but you can't have it" — which turns the endpoint
into a way to discover which IDs are real. So the failure is indistinguishable
from a resource that never existed. There's a test that asserts exactly that:
same status, same code, same message, byte for byte.

The check itself reads only from *your own* partition of the database, so
another user's project isn't rejected — it's never read at all.

### 4. The URL is parsed, never pattern-matched

Repository URLs go through the browser-standard `URL` parser, then get checked
piece by piece. A regex would let all of these through:

| Input | Why it's dangerous | Result |
|---|---|---|
| `https://github.com.evil.io/a/b` | Looks like GitHub to a pattern | rejected |
| `https://user:pass@github.com/a/b` | Credentials get stored and logged | rejected |
| `http://169.254.169.254/` | AWS instance metadata — classic SSRF | rejected |
| `https://github.com:8080/a/b` | Unexpected port | rejected |
| `https://github.com/../etc/passwd` | Traversal attempt | **normalised** to `github.com/etc/passwd` |

That last row is worth pausing on. The parser collapses `..` before we ever look
at the path, so the attack defuses itself into an ordinary, nonexistent repo
name. My test originally expected a rejection and was **wrong about the code** —
the test is now written to document what actually happens and why it's safe.

## What is live

| | |
|---|---|
| API | `https://66y53za7pf.execute-api.ap-south-1.amazonaws.com` |
| Table | `deployment-platform` (on-demand, PITR, KMS-encrypted) |
| Test table | `deployment-platform-test` — integration tests refuse any other |
| Lambda | `deployment-platform-api`, 512 MB, 10s timeout |

Verified live: health check, project creation, deployment creation returning
`202 QUEUED`, listing, and every negative case above.

## A security limitation, stated plainly

**The API has no authentication yet.** Every caller is treated as the same
stand-in user. Anyone who finds the URL is that user.

Authorization *is* real — ownership is checked on every project-scoped route,
and the multi-user tests prove it. What's missing is authentication: proving
*which* user you are. That arrives in M6.

This is acceptable right now because the API only writes database rows. **It
stops being acceptable in M4**, when a request will start a container and
therefore spend money. Until then, three things bound it: request throttling at
5/sec, a 10-project cap per user, and `api_enabled = false` takes the endpoint
down entirely.

The security note is written at the top of `infra/stacks/app/api.tf` so it can't
be missed by anyone reading the infrastructure.

## Why the API was built locally first

Everything in M3 was proved against **real DynamoDB but without Lambda or API
Gateway** — the handlers were called directly, in tests that run in seconds.

Those two services only *transport* the request. Deploying adds transport, not
behaviour. So behaviour was proved where the feedback loop is seconds rather
than minutes, and deploying was the last step rather than the debugging loop.

That is your "localhost first" rule applied properly. It couldn't be applied to
CloudFront in M2 because no local CloudFront exists — but it applies fully here,
and it's how M4 will be built too.

## Numbers

- **235** local tests, ~8 seconds, no network
- **42** integration tests against real AWS, ~26 seconds
- **~$1.30/month** total, unchanged — Lambda, API Gateway and DynamoDB are all
  inside their free tiers at this volume

## Next: M4

The one where it becomes real. A queue, a container registry, Fargate, and the
four pieces that connect the front desk to the kitchen — dispatcher, source
fetcher, reconciler, sweeper.

**Done looks like:** one API call, under three minutes, a working URL. No manual
steps.
