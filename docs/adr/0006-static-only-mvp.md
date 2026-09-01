# ADR-0006: Support static output only in the MVP

**Status:** Accepted | **Date:** 2026-09-01

## Context

The original design listed `.next/` as an artifact directory alongside `dist/` and `build/`. This
conflates two fundamentally different things.

`next build` produces a **server**: a Node process that renders pages per request, plus a routing
manifest, server components, API routes, middleware, and an image optimizer. There is nothing to
put on S3. Only `output: 'export'` produces a static `out/` directory.

Leaving this ambiguous is how the project silently triples in scope. Supporting SSR means
request-time compute, a router that maps hostnames to running functions, cold-start handling,
per-deployment runtime configuration, streaming responses, and a way to run *untrusted* server code
continuously rather than for ten bounded minutes. That last point is the real cost: the current
security model depends on untrusted code running briefly in a disposable sandbox. Long-lived
untrusted request handlers are a different threat model entirely.

## Decision

The MVP deploys **static output only**. A project must produce a directory of static files.

| Framework | Detection | Output |
|---|---|---|
| Vite | `vite` in deps | `dist/` |
| CRA | `react-scripts` in deps | `build/` |
| Astro (static) | `astro` in deps | `dist/` |
| Next.js | `next` in deps **and** `output: 'export'` | `out/` |
| Plain static | no build script | repo root |

Anything else is **rejected at validation time with a clear error**, including a Next.js project
without `output: 'export'`. Rejecting loudly beats guessing: a platform that silently deploys an
empty directory is worse than one that refuses.

## Consequences

- Scope stays achievable. The five engineering ideas the project exists to demonstrate are all
  fully exercised by static deployments.
- The security model stays coherent: untrusted code runs only during a bounded build.
- Real limitation, honestly stated: this is a static-site platform, not a Vercel replacement.
  Saying so is stronger than implying otherwise and being caught by one question.
- Framework detection stays a small lookup table rather than an open-ended heuristic.

## Alternatives considered

- **SSR via Lambda per deployment.** The natural extension, and the right Phase 4 project. Rejected
  for the MVP: roughly doubles the system.
- **SSR via long-running Fargate services.** Rejected: continuous untrusted execution, and cost
  scales with deployment count rather than with traffic.
- **Silently accepting Next.js and deploying `.next/static`.** Rejected: produces a broken site and
  a confusing failure, which is the worst outcome of the three.
