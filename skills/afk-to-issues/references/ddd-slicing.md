# DDD-Aware Backlog Slicing

**Purpose**: Slice PRD user stories into backlog items along bounded context boundaries, not horizontal layers.
**When**: Every afk-to-issues session — after reading PRD and identifying contexts.
**Output**: provider-neutral backlog items with bounded context annotations and relevant ADR references.

---

## Core Principle

**Slice vertically along bounded contexts, not horizontally across layers.**

| | ❌ Wrong (horizontal slice) | ✅ Correct (vertical slice) |
|--|---|---|
| Issue 1 | Add L2 entity model | Ingest → L2 entity extraction + storage |
| Issue 2 | Add L2 repository | Query → Archive API + storage |
| Issue 3 | Add L2 service | Graph → Ego API + traversal |

Horizontal slices mean Issue 1 can't be tested independently — it only creates the model, nothing else works.

Vertical slices can be implemented, tested, and shipped independently within one context.

---

## Slicing Rules

### Rule 1 — One Context Per Backlog

Each backlog item should operate within **one bounded context**.
If work crosses a context boundary, split into multiple items with `dependsOn` links.

### Rule 2 — Full Stack Within Context

A vertical slice includes everything needed for that context to work:
- Data model
- API endpoint
- Business logic
- Tests

### Rule 3 — Aggregate Boundaries

If an aggregate (e.g., WikiPage) spans multiple concerns, split along the aggregate's invariant groups.

### Rule 4 — Cross-Context Events

If item A publishes an event and item B consumes it, B MUST list A in `dependsOn`.

---

## Backlog Manifest Item with Architecture Context

```markdown
## Context
<PRD link>

## Bounded Contexts
- <context name from PRD>

## Relevant ADRs
- ADR-NNNN: <title>

## Acceptance Criteria (machine-checkable)
- [ ] <text> -- <evidence_type> -- <check_command>
```

---

## Slicing Checklist

Before emitting a backlog manifest item, confirm:

- [ ] Does this backlog item operate within ONE bounded context?
- [ ] Can this be implemented and tested without depending on another incomplete item?
- [ ] Does it include everything within the context (model + API + logic + test)?
- [ ] If it triggers downstream contexts via events, does the consumer list this item in `dependsOn`?

---

## Context-to-Issue Mapping Example

Given PRD with contexts: Order, Inventory, Notification

```
PRD User Story: "Customer can reorder an out-of-stock item"

→ backlog-inventory:  [Inventory] Reorder trigger: detect low stock, create reorder proposal
    dependsOn: []

→ backlog-order:  [Order] Reorder: create new Order from reorder proposal
    dependsOn: [backlog-inventory]

→ backlog-notification:  [Notification] Reorder: notify customer when item is available
    dependsOn: [backlog-order] (same Order trigger, different behavior)
```

---

## Anti-Patterns

- MUST NOT create a backlog item that spans two bounded contexts without splitting
- MUST NOT create an item for only "the model" or "the API" — it must be a full vertical slice
- MUST NOT omit `dependsOn` for event-driven cross-context dependencies
- MUST NOT slice so fine that each item is just one method — aggregate related changes
