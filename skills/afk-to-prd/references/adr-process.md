# ADR Process Guide

**Purpose**: When and how to record Architecture Decisions during PRD drafting.
**When**: Every afk-to-prd session where a significant technical choice is made.
**Output**: `docs/adr/ADR-NNNN-title-slug.md` (status: `proposed`) in the target project.

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

### During PRD Drafting

1. While writing PRD, note any significant technical choices being made
2. For each choice, ask: "Is this expensive to change later?" If yes → write ADR
3. Fill in Context and Decision in PRD's `## Architecture Decisions` table
4. Create `docs/adr/ADR-NNNN-title-slug.md` with full details (status: `proposed`)
5. Reference ADR number in PRD document

### ADR Numbering

Use 4-digit zero-padded numbers: `ADR-0001`, `ADR-0002`, etc.
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

## Integration with PRD

```markdown
## Bounded Contexts

| Context | Owner | Key Terms |
|---------|-------|-----------|
| WikiPage | core | Page, Slug, Layer |

## Architecture Decisions

| ADR | Decision | Module Mode | Status | PRD Section |
|-----|----------|------------|--------|-------------|
| ADR-0001 | Watermill Redis Stream mode | — | accepted | docs/adr/ADR-0001.md |
| ADR-0002 | PostgreSQL for order data | Deep Module | accepted | docs/adr/ADR-0002.md |
| ADR-0003 | Use MinIO for object storage | — | proposed | docs/adr/ADR-0003.md |

*(Module Mode: Deep Module = vertical slicing by bounded context; Shallow Module = layered)*
```

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
