# 10 — M2 Walkthrough (plain English)

M0 and M2 are applied and verified against real AWS. This is what exists now,
what it cost, and the two things that went wrong on the way.

## What M2 is

M1 turned source code into a folder of files. **M2 puts that folder on the
internet**, behind a CDN, with the right caching, over HTTPS, from a bucket
nobody can read directly.

```
built folder  ->  S3 (private)  ->  CloudFront  ->  browser
                                        ^
                                   a small function
                                   decides which folder
```

**Why second, right after the container?** Because it is the highest-risk piece.
CloudFront has no idea what a "deployment" is — mapping a web address to a folder
inside a bucket is something you have to build, and every mistake costs a deploy
cycle to find. Better to face it early.

## What is live now

| | |
|---|---|
| AWS account | `220438080921`, region `ap-south-1` (Mumbai) |
| Distribution | `d3895jyfnxjrwh.cloudfront.net` |
| Artifacts bucket | `deployment-platform-artifacts-220438080921` (private) |
| Sources bucket | `deployment-platform-sources-220438080921` (private, 1-day expiry) |
| Routing table | CloudFront KeyValueStore `7de72970-…` |
| State bucket | `deployment-platform-tfstate-220438080921` |

A live deployment: <https://d3895jyfnxjrwh.cloudfront.net/d/dep_m2demo/>

## The three stacks

**`infra/bootstrap`** — applied once, by hand, with local state. Creates the S3
bucket that every other stack keeps its state in, plus the spend guardrails: a
monthly budget with alerts at 50/80/100%, a billing alarm, and cost-anomaly
detection.

Guardrails come first on purpose. This platform runs strangers' code on a finite
credit pool. A repository with a crypto miner in `postinstall` is a spend event,
and the alarm has to already exist when it happens — not be set up afterwards.

**`infra/stacks/data`** — the two buckets and an encryption key. Both buckets are
completely private and refuse non-HTTPS requests. Source archives self-delete
after a day, because keeping copies of other people's private repositories longer
than needed serves no purpose.

**`infra/stacks/edge`** — CloudFront, the routing function, and the routing table.

## How the routing actually works

CloudFront can't map `dep-abc.example.com` to a folder on its own. So a tiny
JavaScript function runs at the edge on **every request**, in microseconds:

```
request comes in
   |
   +- read the Host header
   |
   +- look it up in the KeyValueStore  ->  "projects/prj_1/deployments/dep_abc"
   |
   +- if the path has no file extension, add /index.html
   |
   +- rewrite the address to include that folder
   |
   v
S3 serves the file
```

The function can't make network calls at all — no database lookups. The
KeyValueStore is the only thing it can read, which is why the routing table has
to be duplicated there rather than kept only in a database.

It works in **two modes**. With a custom domain, the lookup key is the hostname.
Without one, the key is a deployment id read from the path (`/d/dep_abc/…`).
That second mode is why all of this could be built and proven before your domain
is connected.

## Two things that went wrong

**1. AWS refused to create a cost-anomaly monitor.**

> `ValidationException: Limit exceeded on dimensional spend monitor creation`

AWS allows exactly **one** per account, and now auto-creates a
`Default-Services-Monitor` in most accounts. The fix wasn't to fight it — it was
to attach our alert subscription to the monitor that already existed. The
Terraform now takes an optional ARN and only creates a monitor in an account that
genuinely has none.

**2. Missing files returned 403, not 404.**

A request for a file that doesn't exist came back as S3's raw
`403 Forbidden` in XML. That is an information leak: it tells anyone probing the
difference between "this exists but you can't have it" and "this doesn't exist".

The cause was subtle. CloudFront cannot change a status code without a page to
serve, and the page it was told to serve (`/404.html`) didn't exist in the
bucket — so CloudFront gave up and passed S3's error through unchanged. The fix
was to actually create that page, as part of the stack. It lives at the bucket
root, outside every deployment folder, and is deliberately generic because it is
shown for every deployment.

## Verified live

Not "should work" — actually checked against the running distribution.

| Check | Result |
|---|---|
| `/d/dep_m2demo/` → index.html | 200 `text/html` |
| `/d/dep_m2demo/about/` → about/index.html | 200 `text/html` |
| `/d/dep_m2demo/about` (no slash) | 200 `text/html` |
| `/d/dep_m2demo/assets/app.js` | 200 `text/javascript` |
| Unknown deployment | 404 |
| Request with no `/d/` prefix | 404 |
| Missing file | 404 (not 403) |
| **Raw `../` traversal** | **400 at the edge** |
| **Nested `../../../`** | **400** |
| **Encoded `%2e%2e`** | **400** |
| **Mixed `..%2f`** | **400** |
| Reading the S3 bucket directly | 403 |
| Security headers (HSTS, nosniff) | present |

A note on how that traversal test was run. The first attempt used plain `curl`
and appeared to pass — but **curl silently normalises `../` before sending**, so
the attack never reached CloudFront. Re-running with `--path-as-is` sends the raw
path, and only then is the edge function's guard actually being tested. A
security check that passes for the wrong reason is worse than no check.

## About the caching

You may notice `assets/app.js` gets `max-age=0, must-revalidate` rather than
being cached forever. That is correct, not a bug.

Only **fingerprinted** filenames — `app.4f3a9b2c.js`, where the content hash is
in the name — can be cached forever, because changing the content produces a new
name. A plain `app.js` can change under the same name, so caching it forever
would leave people looking at an old version after a rollback. Real Vite builds
produce fingerprinted names and will get the long cache automatically.

## What it costs

| | Monthly |
|---|---|
| KMS key | $1.00 |
| S3 (state, artifacts, sources) | ~$0.30 |
| CloudFront, Functions, KeyValueStore | $0.00 (free tier) |
| Budgets, alarm, anomaly detection | $0.00 (free tier) |
| **Total** | **~$1.30** |

No NAT Gateway, no interface endpoints, no Route53 yet. Against a ~$100 credit
pool, that is roughly 6 years of idle running.

## Doing it yourself

```bash
# build a site locally (M1)
OUTPUT_DIR="$PWD/.out" WORK_DIR="$PWD/.work" DEPLOYMENT_ID=dep_demo \
  node apps/builder/dist/builder.mjs tests/fixtures/tarballs/static-ok.tar.gz

# upload it, using the Content-Type and Cache-Control from the manifest
bash scripts/publish-to-s3.sh .out/dep_demo

# point a route at it
bash scripts/seed-route.sh dep_demo projects/prj_local/deployments/dep_demo

# visit it
curl https://d3895jyfnxjrwh.cloudfront.net/d/dep_demo/
```

Those three steps are manual today. **M4 is where the platform does them itself**,
which is the entire point of the control plane.

## Still outstanding

- **Your domain.** Set `domain_name` in the edge stack and the certificate,
  wildcard alias, and DNS records appear. Nothing needs restructuring.
- **Confirm the SNS email.** AWS sent a subscription confirmation to
  `zenmohit08@gmail.com`; the billing alarm cannot notify you until it is clicked.
- **Enable billing alerts** in the console: Billing → Billing Preferences →
  "Receive CloudWatch billing alerts". There is no API for this, so it has to be
  a manual tick, and without it the alarm sits in `INSUFFICIENT_DATA` forever.
- **The Docker image is still unbuilt** — the daemon has never been running.

## Next

M3 — state and API. DynamoDB with the single-table design, Lambda handlers,
API Gateway, and the state machine with its conditional writes. That is where
`POST /deployments` starts returning a deployment id.
