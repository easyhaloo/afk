# DDD-Aware Issue Slicing

**Purpose**: Slice PRD user stories into issues along bounded context boundaries, not horizontal layers.
**When**: Every afk-to-issues session — after reading PRD and identifying contexts.
**Output**: GitLab issues with bounded context annotations and relevant ADR references.

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

### Rule 1 — One Context Per Issue

Each issue should operate within **one bounded context**.
If work crosses a context boundary, split into multiple issues with `blocked_by` links.

### Rule 2 — Full Stack Within Context

A vertical slice includes everything needed for that context to work:
- Data model
- API endpoint
- Business logic
- Tests

### Rule 3 — Aggregate Boundaries

If an aggregate (e.g., WikiPage) spans multiple concerns, split along the aggregate's invariant groups.

### Rule 4 — Cross-Context Events

If issue A publishes an event and issue B consumes it, B MUST be `blocked_by` A.

---

## Issue Template with Architecture Context

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

Before creating an issue, confirm:

- [ ] Does this issue operate within ONE bounded context?
- [ ] Can this be implemented and tested without depending on another unmerged issue?
- [ ] Does it include everything within the context (model + API + logic + test)?
- [ ] If it triggers downstream contexts via events, is the consumer issue `blocked_by` this one?

---

## Context-to-Issue Mapping Example

Given PRD with contexts: Order, Inventory, Notification

```
PRD User Story: "Customer can reorder an out-of-stock item"

→ Issue #1:  [Inventory] Reorder trigger: detect low stock, create reorder proposal
    blocked_by: none

→ Issue #2:  [Order] Reorder: create new Order from reorder proposal
    blocked_by: #1

→ Issue #3:  [Notification] Reorder: notify customer when item is available
    blocked_by: #2 (same Order trigger, different behavior)
```

---

## Anti-Patterns

- MUST NOT create an issue that spans two bounded contexts without splitting
- MUST NOT create an issue for only "the model" or "the API" — must be full vertical
- MUST NOT skip `blocked_by` for event-driven cross-context dependencies
- MUST NOT slice so fine that each issue is just one method — aggregate related changes
