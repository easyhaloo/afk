---
name: afk-grill-me-context
disable-model-invocation: true
description: >-
  Gap-fill interview skill — use when bounded contexts, architecture
  docs, a prior draft, or code audit results already exist and need
  verification, correction, or expansion through targeted questioning.
  Starts from what is already known, digs into holes. May read code to
  verify context against the actual codebase. Produces a revised
  CONTEXT.md via the same Step 4 gate (Approve / Revise / Drill /
  Add Open Question). Output goes to /tmp/, never to the repo working tree.
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
  Bash(chown*) Bash(mkdir*)
---

# Grill-me with Context (Gap-fill)

**Goal:** verify, correct, and deepen existing context through targeted
questioning. A review and gap-fill on pre-existing material — for a
from-scratch interview, the caller needs a different entry point.
**Mode:** HITL — every round needs explicit human input.
**Contract:** (existing context + topic) → approved `CONTEXT.md`.

## When to use

| Scenario |
|----------|
| Existing bounded contexts need verification |
| Architecture docs have assumptions to probe |
| Prior alignment draft exists, revisit with more info |
| Stakeholder alignment done, need to verify specifics |

## Steps

### Step 1 — Identify the topic and review given context

Read whatever context the human has provided and form a picture of what
is already known.

If no context is provided → STOP.

### Step 2 — Gap-fill through targeted questioning (HITL)

Based on the existing context, question specifically around gaps:

- Does the existing bounded context boundary still hold?
- Are there terminology conflicts not captured?
- What invariants are missing or unclear?
- Are cross-context relationships undocumented?
- What business rules are ambiguous?

Use `AskQuestion` with structured `options`. Apply multi-select when
multiple verification topics are simultaneously relevant. Apply
single-select when options are mutually exclusive.

**Optional code audit:** if context is vague or may not match the
codebase, read code to verify bounded context accuracy, actual
terminology, undocumented invariants, or cross-context coupling.
Findings are evidence for human verification questions, NOT final answers.

**Core verification topics:**

1. **Boundary accuracy** — do bounded contexts reflect how the system works?
2. **Terminology conflicts** — any terms meaning different things in different contexts?
3. **Missing invariants** — what rules must stay true within each context?
4. **Cross-context gaps** — what events/data flow between contexts is undocumented?

### Step 3 — Draft summary (show only, NOT written)

Show the updated draft `CONTEXT.md` — mark which parts were
pre-existing and which were added during this session.

### Step 4 — Gate: explicit user confirmation (AskQuestion)

1. **Approve** → write to `/tmp/grill-me-context-*.md`
2. **Revise specific sections** → return to Step 3
3. **Drill deeper on a topic** → return to Step 2
4. **Add an open question** → record gap, then write with the gap labeled

### Step 5 — Write to /tmp/ (only after Step 4 confirmation)

Write directly to `/tmp/grill-me-context-<YYYYMMDD-HHMMSS>.md` using
the Write tool. Never write to the repo working tree.

## Anti-patterns

- MUST NOT write CONTEXT.md to the repo working tree — only to `/tmp/`.
- MUST NOT skip the Step 4 gate.
- MUST NOT update bounded contexts based on code alone without human confirmation.
