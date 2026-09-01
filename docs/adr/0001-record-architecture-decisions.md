# ADR-0001: Record architecture decisions

**Status:** Accepted | **Date:** 2026-09-01

## Context

The original design document explained *what* the architecture is but rarely *why* a given option
won. Six weeks later the reasoning is gone, and every settled question gets re-litigated. In an
interview, "why SQS and not Step Functions?" is a much better question to have a written answer to
than a diagram.

## Decision

Record every significant architectural decision as a numbered ADR in `docs/adr/`, written **at the
moment the decision is made**, not retrospectively. Format: Context, Decision, Consequences,
Alternatives considered. Superseded ADRs are never deleted, only marked superseded.

## Consequences

- The reasoning survives, including for decisions that later turn out to be wrong.
- "Alternatives considered" is the section that carries the weight. An ADR without it is just a note.
- Slight overhead per decision. Worth it.
