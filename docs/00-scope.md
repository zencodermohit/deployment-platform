# 00 — Scope

## Objective

Build a deployment platform that takes a GitHub repository containing a **statically buildable**
web application and turns it into a live, CDN-served URL — safely, asynchronously, and
reproducibly.

The measure of success is not feature count. It is whether the system demonstrates correct
engineering judgment on five specific problems:

1. **Executing untrusted code safely.** A user's `package.json` can run anything.
2. **Asynchronous state management.** A build takes minutes; an HTTP request cannot wait.
3. **Idempotency under at-least-once delivery.** Duplicate messages must not produce duplicate work.
4. **Immutable deployments.** Rollback is a pointer swap, never a rebuild.
5. **Reproducible infrastructure.** The whole system rebuilds from Terraform.

If the project demonstrates those five things convincingly, it has succeeded, even with a small
feature set. If it has many features and gets any of those five wrong, it has failed.

## In scope (MVP)

- Email/password or GitHub OAuth login; sessions
- Create a project bound to one GitHub repository
- Trigger a deployment for a branch or commit SHA
- Asynchronous build in an isolated container
- Artifacts to an immutable S3 prefix
- Serve via CloudFront over a per-deployment subdomain
- Live deployment status and logs in the UI
- Rollback by promoting a previous successful deployment
- Terraform for all infrastructure
- GitHub Actions CI

## Explicitly out of scope

Each of these is a defensible cut, not an oversight. Say so if asked.

| Excluded | Why |
|---|---|
| **Server-side rendering** | `next build` produces a *server*, not static files. Supporting it means request-time compute, a router, and cold-start handling — a different product. MVP requires static output. |
| **Serverless functions (`/api/*`)** | Same reason. Interesting, but doubles the system. |
| **Build caching** | Real value only at scale we won't reach. Adds cache-poisoning surface across tenants. |
| **Monorepo / multi-package builds** | Long tail of edge cases, near-zero learning value. |
| **Team accounts, RBAC, billing** | Product surface, not engineering substance. |
| **Multi-region** | Cost, and nothing is learned that single-region doesn't teach. |
| **Custom user-supplied domains** | Requires per-domain ACM issuance and validation flows. Phase 3 at earliest. |

## Supported frameworks (MVP)

Detection is by convention, not magic. A project must produce a directory of static files.

| Framework | Detection | Build | Output |
|---|---|---|---|
| Vite | `vite` in deps | `npm run build` | `dist/` |
| Create React App | `react-scripts` in deps | `npm run build` | `build/` |
| Astro (static) | `astro` in deps | `npm run build` | `dist/` |
| Next.js (export only) | `next` in deps **and** `output: 'export'` | `npm run build` | `out/` |
| Plain static | no build script | none | repo root |

Anything else is rejected at validation time with a clear error. **Rejecting loudly beats
guessing wrong** — a platform that silently deploys an empty directory is worse than one that
refuses.

## Non-goals

- Matching Vercel's performance, caching behaviour, or feature surface.
- Handling adversarial load. Abuse controls exist (quotas, limits) but are not battle-tested.
- Operating as a real multi-tenant service. There is one operator and a handful of test users.

## Success criteria

The project is done when all of the following hold:

- [ ] A fresh AWS account reaches a working system from `terraform apply` plus one image push.
- [ ] Deploying a public Vite repo produces a working URL in under 3 minutes.
- [ ] A repo whose `postinstall` attempts to read AWS credentials or reach the control plane
      fails to obtain anything useful. **This is tested, not assumed.**
- [ ] Delivering the same SQS message twice produces exactly one build.
- [ ] Killing a build container mid-run leaves the deployment in `FAILED`, not stuck in `BUILDING`.
- [ ] Rollback changes the served content without running a build.
- [ ] Always-on cost stays under $10/month; total spend stays inside the credit pool.
- [ ] A repo that burns CPU in `postinstall` is capped by timeout and concurrency limits, and
      triggers a budget alarm rather than draining the account.
