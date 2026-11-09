# ADR Process Guide

**Purpose**: Record significant technical decisions separately from the product requirements document.
**When**: During technical design or implementation planning, when a technical choice meets the criteria below. The PRD workflow may identify the need for a future ADR, but must not make implementation decisions on behalf of the user.
**Output**: `docs/adr/NNNN-title-slug.md` (status: `proposed`) in the target project.

---

## What is an ADR?

An Architecture Decision Record captures:
- **Context** — the problem or forces at play
- **Decision** — what we decided
- **Alternatives** — what else we considered and why we didn't pick it
- **Consequences** — positive and negative outcomes

---

## When to Write an ADR

Write an ADR when the decision:

| Criterion | Description |
|-----------|-------------|
| Irreversible | Cannot be easily undone without significant cost |
| High-risk | Affects security, performance, or data integrity |
| Cross-cutting | Touches multiple modules or teams |
| Strategic | Sets direction for future development |
| Expensive to change | Would require major refactoring to reverse |

**Do NOT write ADRs for**: trivial naming choices, cosmetic refactors, straightforward bug fixes.

---

## ADR Lifecycle

```
proposed → accepted → [deprecated | superseded by ADR-NNNN]
```

| Status | Meaning |
|--------|---------|
| `proposed` | Under discussion, not yet implemented |
| `accepted` | Implemented and being followed |
| `deprecated` | No longer relevant (e.g., feature removed) |
| `superseded` | Replaced by a newer ADR (link to replacement) |

---

## Process Steps

### After Product Requirements Are Confirmed

1. Keep the PRD focused on confirmed product context, user stories, scope, business rules, and observable behavior.
2. If a technical decision is necessary, defer it to technical design rather than adding architecture choices or implementation details to the PRD.
3. During technical design, assess the decision against the criteria below and create an ADR when warranted.
4. Record the technical context, alternatives, decision, and consequences in `docs/adr/NNNN-title-slug.md`.
5. Link the ADR from the technical design or implementation plan. Only mention a technical constraint in the PRD when it is a confirmed organizational constraint that affects product behavior.

### ADR Numbering

Use 4-digit zero-padded numbers in the filename: `0001`, `0002`, etc. The H1 inside the file keeps the `ADR-NNNN:` prefix.
Next number = max existing number + 1. Check `docs/adr/` in the target project.

### Minimum Viable ADR

Even a short ADR is better than no record:

```markdown
# ADR-0003: Use Redis Stream for event bus

**Status**: proposed

## Context

We need an event bus for cross-service communication.
Watermill supports Redis Stream and Go channel modes.

## Decision

Use Watermill with Redis Stream mode.

## Alternatives

- Go channel mode: only works within single process
- Kafka: overkill for our scale

## Consequences

- ✅ Cross-node event delivery
- ✅ Durable queue (survives restarts)
- ❌ Adds Redis 8 dependency
```

---

## Relationship to the PRD

The PRD is a product document, not an architecture decision log. Do not add an `Architecture Decisions` table, module ownership, module modes, database choices, or ADR lifecycle details to it. Keep those in technical design and ADR documents. The PRD may state a confirmed technical or organizational constraint only when it materially affects the product contract; describe the constraint and its product impact, not the implementation solution.

---

## Architecture Decision Checklist

For each PRD, verify these structural decisions are addressed:

- [ ] **Bounded contexts**: are bounded contexts identified and documented?
  - Each context = independent semantic boundary
  - Cross-context communication = events or explicit interfaces
- [ ] **Module organization**: which mode?
  - **Deep Module + Vertical Slicing (DEFAULT)**: each bounded context = separate package under `internal/domain/`, owns its own domain/app/infra. Use for features spanning multiple contexts or complex business logic.
  - **Shallow Module + Layered (opt-in)**: `handlers/` + `services/` + `repos/`. Use only for simple CRUD on one entity with no cross-context interactions.
- [ ] **Why this choice?** Record the trade-off in the ADR's Alternatives section.
  - Deep Module: large internal logic, small interface. Enables independent deploy/migration.
  - Shallow Module: quick to set up, but cross-context changes span multiple layers.

---

## Anti-Patterns

- MUST NOT mark ADR as `accepted` before implementation
- MUST NOT skip the Alternatives section — every decision had alternatives
- MUST NOT write vague Context like "we need a database" — be specific
- MUST NOT create ADR for every minor choice — reserve for significant decisions
- MUST NOT leave ADR in `proposed` forever — update when decision is implemented

---

## Update ADR README

After creating a new ADR, update `docs/adr/README.md`:

```markdown
## Index

| Number | Title | Status | Date |
|--------|-------|--------|------|
| ADR-0001 | Use Watermill for event bus | accepted | 2026-06-01 |
| ADR-0002 | PostgreSQL for order data | accepted | 2026-06-10 |
| ADR-0003 | Use MinIO for object storage | proposed | 2026-07-20 |
```
