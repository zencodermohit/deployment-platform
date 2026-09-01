# ADR-0004: The control plane fetches source; the container never sees a GitHub token

**Status:** Accepted | **Date:** 2026-09-01

## Context

The original design had the build container clone the repository itself. For private repositories
that requires a GitHub credential inside the container.

But the same document's central principle is that repository code is hostile and may run arbitrary
code during `npm install`. A `preinstall` script reads the environment and the filesystem before
any build step runs. A token placed in that container is exfiltrated in milliseconds - and a GitHub
OAuth user token or App installation token grants read access to **every repository it covers**,
not just the one being built.

The container cloning its own source silently violates the project's own security premise.

## Decision

The **trusted** side fetches the source:

1. A source-fetcher Lambda mints a GitHub App installation token (1-hour TTL, installation-scoped).
2. It calls `GET /repos/{owner}/{repo}/tarball/{sha}`, streaming the response while enforcing the
   size cap.
3. It writes the tarball to `s3://sources/{deploymentId}.tar.gz`.
4. The dispatcher generates a **presigned GET URL**, 15-minute TTL, for that single object.
5. The container receives only that URL. It has no GitHub credential and never contacts GitHub.

## Consequences

- A fully compromised container yields a presigned URL to a tarball it already has. Worthless.
- GitHub App installation tokens replace OAuth user tokens: shorter-lived, repository-scoped,
  revocable per installation.
- Extra hop and extra S3 storage. Sources expire after 24 hours via a lifecycle rule.
- The size cap is enforced **before** any container starts, so an oversized repo costs nothing.
- Bonus: source becomes content-addressable, which is the foundation for build caching later.

## Alternatives considered

- **Clone in the container with a short-lived token.** Rejected: "short-lived" means an hour;
  exfiltration takes a millisecond.
- **Clone with a deploy key scoped to one repo.** Better, but still a durable credential inside
  hostile code, plus per-project key management.
- **Public repositories only.** Sidesteps the problem, but the private-repo flow is most of what
  makes the platform interesting.
