# ADR-0010: One Lambda for the API, routing internally

**Status:** Accepted | **Date:** 2026-09-01

## Context

The control-plane API has six routes today (projects and deployments, create /
read / list) and will have roughly a dozen by M6. The reflexive serverless
answer is one Lambda per route, wired to its own API Gateway integration.

## Decision

One function, `deployment-platform-api`, with a small internal router matching
method plus a path template. API Gateway has a single `$default` route pointing
at it.

## Consequences

- Adding an endpoint is a code change, not a Terraform change.
- One warm execution environment serves every route, so the second request to
  *any* endpoint is warm rather than each route paying its own cold start.
- One role, one log group, one integration instead of a dozen of each.
- **The trade-off:** every route carries the union of all permissions. That is
  acceptable here because all six already need the same DynamoDB access to the
  same table. It stops being acceptable the moment one route needs something
  meaningfully more dangerous — the status callback in M4 is the likely first
  candidate, since it is reachable by the untrusted build container.
- Splitting later is mechanical: the handlers are already separate modules with
  no shared state, so peeling one into its own function is a build-config change
  rather than a rewrite.

## Alternatives considered

- **Lambda per route.** The finest-grained IAM, and genuinely right at scale.
  Rejected for now: six cold starts, six roles, six log groups and six
  integrations to buy isolation between routes that need identical permissions.
- **A framework (Hono, Fastify with an adapter).** Would give routing, parsing
  and middleware for free. Rejected because the routing need is a dozen lines,
  and a framework in the request path is a dependency to keep patched for no
  capability we lack.
- **Lambda function URL instead of API Gateway.** Cheaper and simpler, but no
  request throttling — and throttling is currently the only thing bounding an
  unauthenticated API.
