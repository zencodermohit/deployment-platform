# Deployment Platform

A simplified, production-minded deployment platform: connect a GitHub repo, trigger a build,
get a URL. Built to demonstrate the core engineering of a service like Vercel — not to clone it.

**Status:** design phase. No code yet.

## The one-paragraph version

The system is split into a **control plane** (trusted: auth, deployment records, state machine,
orchestration) and a **build plane** (untrusted: runs arbitrary code from user repositories inside
an ephemeral, credential-less Fargate task). Deployment requests are accepted asynchronously,
queued, dispatched to an isolated container, and the resulting artifacts are written to an
immutable S3 prefix and served by CloudFront. Rollback is a pointer swap, never a rebuild.

## Design constraints

These are deliberate and shape almost every decision in `docs/`:

| Constraint | Consequence |
|---|---|
| Portfolio / interview artifact | Aggressively narrow scope; depth over breadth |
| ~$100 in AWS credits (finite, expiring) | Cheap always-on core; costly services stood up, evidenced, then destroyed |
| Custom domain available | Real wildcard subdomain routing from Phase 2 |

## Documents

Read in this order.

| Doc | What it answers |
|---|---|
| [00-scope.md](docs/00-scope.md) | What we are and are not building. Read this first. |
| [01-architecture.md](docs/01-architecture.md) | How it actually works, mechanism by mechanism |
| [02-data-model.md](docs/02-data-model.md) | DynamoDB table design and every access pattern |
| [03-api.md](docs/03-api.md) | HTTP contract |
| [04-build-contract.md](docs/04-build-contract.md) | The interface between control plane and build container |
| [05-threat-model.md](docs/05-threat-model.md) | Trust boundary, threats, controls, accepted risks |
| [06-cost-model.md](docs/06-cost-model.md) | What this costs and what would make it expensive |
| [07-roadmap.md](docs/07-roadmap.md) | Milestones with exit criteria |
| [08-testing.md](docs/08-testing.md) | How a distributed async system gets tested |
| [adr/](docs/adr/) | Decision records — the *why* behind each choice |

## Planned repository layout

Sliced by lifecycle, not by AWS service taxonomy. Things that change together live together.

```
.
├── apps/
│   ├── web/                  React + Vite dashboard
│   ├── api/                  Lambda handlers (control plane)
│   └── builder/              Build container entrypoint (runs in Fargate)
├── packages/
│   ├── core/                 Domain types, state machine, validation schemas
│   └── aws/                  Thin typed wrappers over AWS SDK clients
├── infra/
│   ├── bootstrap/            TF state bucket + lock table (applied once, by hand)
│   └── stacks/
│       ├── network/          VPC, subnets, security groups, gateway endpoints
│       ├── data/             DynamoDB, S3 buckets
│       ├── build/            ECR, ECS cluster, task definition, SQS, IAM
│       ├── edge/             CloudFront, KeyValueStore, ACM, Route53
│       └── app/              API Gateway, Lambda, EventBridge rules
├── docker/
│   └── builder/              Dockerfile for the build image
└── .github/workflows/
```
