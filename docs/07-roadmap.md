# 07 - Roadmap

## A correction to the original build order

The original plan started with "Step 1: Create the React dashboard." **That is backwards, and it
is the most common way projects like this die.**

Order work by *risk*, not by *layer*. The dashboard is the part you already know how to build.
The parts that can actually defeat you are: does the Fargate task launch and report correctly, does
the IAM scoping really hold, and does CloudFront actually rewrite a host into an S3 prefix. Build
those first, with `curl` as your only UI.

If you build the dashboard first, you get three weeks of visible progress followed by the discovery
that the hard part does not work. If you build the build plane first, you find that out on day
four, when changing course is cheap.

**Rule: nothing gets a UI until it works from the command line.**

## Milestones

Each milestone has an exit criterion. Do not start the next one until it passes.

### M0 - Account and guardrails (half a day)

Budgets, billing alarm, Cost Anomaly Detection, MFA on root, an IAM admin user, Terraform state
bucket (`infra/bootstrap`, applied once by hand), CI secrets via OIDC rather than long-lived keys.

**Correction:** this originally said "state bucket + lock table". Terraform 1.10+ locks natively
against S3 via `use_lockfile = true`, which deprecated the DynamoDB lock table. One less resource,
one less bill.

> **Exit:** `terraform apply` works against remote state; a $25 budget alert exists.

### M1 - Vertical slice, no AWS (2-3 days)

The build container, run locally with `docker run`. Takes a tarball path, detects the framework,
installs, builds, writes output to a local directory. No S3, no DynamoDB, no ECS.

> **Exit:** `docker run builder ./fixtures/vite-app.tar.gz` produces a correct `dist/`, and a
> fixture with a failing build exits 13.

### M2 - Artifacts and delivery (3-4 days)

S3 buckets, CloudFront distribution, OAC, the CloudFront Function, the KeyValueStore, ACM wildcard
cert, Route53. Upload a build output by hand and serve it.

> **Exit:** `https://dep-test1.<domain>/` serves the app; `/about/` serves `about/index.html`;
> an unknown path returns `index.html` with 200; the S3 bucket is fully private.

This is the highest-risk milestone. Do it second, while you still have energy for it.

### M3 - State and API (3-4 days)

DynamoDB table, single-table design with both GSIs. Lambda handlers for projects and deployments.
API Gateway. Validation. The state machine with conditional writes. No auth yet - hardcode a user.

> **Exit:** `POST /deployments` returns 202 with a `deploymentId`; the guarded transitions reject
> invalid moves; a unit test proves two concurrent `QUEUED -> PROVISIONING` claims produce exactly
> one winner.

### M4 - Wiring the build plane (4-5 days)

ECR, the ECS cluster and task definition, SQS + DLQ, the dispatcher Lambda, the source fetcher,
the GitHub App, the status callback endpoint, EventBridge + reconciler, the sweeper.

> **Exit:** `POST /deployments` on a real public GitHub repo produces a live URL in under 3
> minutes, with no manual step. **This is the moment the project exists.**

### M5 - Security hardening (3-4 days)

Tighten every IAM policy to the minimum. Write and run all seven security tests from
[05-threat-model.md](05-threat-model.md#security-tests-that-must-exist). Zip-slip protection.
Extraction limits. Both timeout mechanisms. Log redaction. Quotas and the concurrency cap.

> **Exit:** every security test passes **and demonstrably fails when its control is removed.** A
> test that has never failed is not a test.

### M6 - Auth and the dashboard (5-7 days)

GitHub OAuth, sessions, the authorization middleware applied centrally. Then React: project list,
deployment list, deployment detail with the status timeline, live log streaming, retry, rollback.

> **Exit:** a second GitHub account can sign up, deploy a repo, and cannot see the first account's
> projects. Verified by the T11 test, not by clicking around.

### M7 - Operations (2-3 days)

CloudWatch dashboard, EMF metrics, alarms, X-Ray, structured logging, GitHub Actions CI with lint
/ typecheck / test / build, image push to ECR, `terraform plan` on PR and gated `apply` on main.

> **Exit:** a PR shows a Terraform plan; merging deploys; a forced build failure fires an alarm.

### M8 - Tier B demonstration (2-3 days, then destroy)

Flip `network_mode = "private"`. NAT, private subnets, interface endpoints, VPC Flow Logs, WAF,
GuardDuty. Run it, capture everything, `terraform destroy`. Budget ~$7 (see
[06-cost-model.md](06-cost-model.md#tier-b---stand-up-evidence-destroy)).

> **Exit:** screenshots, flow logs, and a GuardDuty finding are committed to `docs/evidence/`,
> and Cost Explorer confirms the resources are gone.

### M9 - Polish

Webhooks for auto-deploy on push, deployment history UI, `README` with an architecture diagram, a
short demo video. **The video matters more than one more feature** - most people reviewing this
will watch 60 seconds and never run it.

## Realistic timeline

**8-11 weeks part-time.** M4 is the milestone that slips; budget more than you think for the first
`RunTask` that actually works end to end.

## Sequencing rules

1. **Terraform from M0.** Retrofitting IaC onto click-ops infrastructure costs more than writing it
   first, every time.
2. **One vertical slice before any breadth.** One repo, one framework, one user, one domain. Widen
   only after that path works end to end.
3. **The UI is last.** Every milestone through M5 is exercised with `curl`.
4. **Security is M5, not "later".** "Later" does not arrive, and the security story is the single
   most valuable thing this project has to say about you.
5. **Write the ADR when you make the decision**, not when you write the README. The reasoning is
   gone within a week.

## Deliberately not on this roadmap

SSR, serverless functions, build caching, monorepos, teams, billing, multi-region, custom
user-supplied domains. Each is defensible to cut; see [00-scope.md](00-scope.md#explicitly-out-of-scope).
Adding any of them before M9 means the project ships nothing.
