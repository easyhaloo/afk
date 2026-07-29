---
name: afk-grill-me
disable-model-invocation: true
description: >-
  Requirements interview skill — use when a feature/epic is ambiguous
  and the team needs shared, falsifiable understanding before building.
  Runs multi-round HITL interviews via AskQuestion. Produces a
  structured CONTEXT.md with Audience, Success Criteria, Non-goals,
  Constraints, and Open Questions. The interview has a non-negotiable
  floor: at minimum, one Audience, one Success Criterion, and one
  explicit Non-goal must be stated — no build proceeds below this floor.
  Output goes to /tmp/, never to the repo working tree.
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
  Bash(chown*) Bash(mkdir*)
---

# Grill-me (Interview)

**Goal:** unambiguous shared understanding of the problem before any
build work. This is a conversation, not a document review.
**Mode:** HITL — every round needs explicit human input; nothing here
proceeds unattended.
**Contract:** (none) → approved `CONTEXT.md`.

## Interview closure

An interview has no natural stopping point unless you impose one:

- **"Enough" is concrete, not a feeling:** stop once each of Audience,
  Success Criteria, Non-goals, and Constraints has at least one specific,
  falsifiable answer — not once the user seems tired of answering.
  Falsifiable means someone could point at a shipped feature and say
  "no, that didn't satisfy this".
- **Diminishing returns:** if two consecutive rounds produce no new
  constraint or non-goal, draft `CONTEXT.md` with what you have and list
  the rest as Open Questions.
- **Conflicting stakeholders:** record the conflict verbatim in Open
  Questions with all positions attributed. MUST NOT silently pick a side.
- **"Just build it" pushback:** acknowledge it, but the floor is
  non-negotiable — audience, one success criterion, one explicit
  non-goal. Below that floor, downstream has nothing to slice into
  machine-checkable AC.

## Steps

### Step 1 — Identify the topic

Note what feature/epic this interview is for. Read the linked
epic/issue title if one exists — use it as the interview anchor.

### Step 2 — Interview rounds (interactive, HITL)

Use `AskQuestion` with structured `options`. Apply multi-select when
multiple topics are simultaneously relevant (e.g. confirming Audience
and Success criteria at once). Apply single-select when options are
mutually exclusive. Options must not exceed 4.

**Core topics (in order, all must be covered at minimum):**

1. **Audience** — who will use this? Who will be affected?
2. **Success criteria** — how do we know this is "done" and "right"?
3. **Non-goals** — what is explicitly out of scope?
4. **Hard constraints** — performance targets, security posture,
   compliance requirements, budget limits.

**Extended topics (add as relevant):**

- Timeline / Milestones
- Stakeholders / Decision-makers
- Integration points
- Data sensitivity
- Failure handling
- Rollback strategy
- Monitoring / Observability requirements
- Dependency constraints

**Dive deep within each topic.** Follow up with "why", "what happens
if", "who decides when", "what does failure look like" — until the
answer space is genuinely exhausted.

### Step 2.5 — Bounded Context Discovery

Keep a running list of domain terms and flag any conflicts — these go
into `CONTEXT.md`.

- Same term, different meanings across parts of the system → context boundary
- Different consistency requirements → different aggregates
- Different teams own different parts → context boundary

### Step 3 — Draft summary (show only, NOT written)

Show the full draft `CONTEXT.md` — Problem, Users, Success Criteria,
Non-goals, Constraints, Open Questions. Nothing is written to disk yet.

### Step 4 — Gate: explicit user confirmation (AskQuestion)

Offer exactly four outcomes:

1. **Approve** → write `CONTEXT.md`
2. **Revise specific sections** → return to Step 3 with updates
3. **Drill deeper on a topic** → return to Step 2
4. **Add an open question** → record gap, then write with the gap labeled

### Step 5 — Write to /tmp/ (only after Step 4 confirmation)

Write directly to `/tmp/grill-me-context-<YYYYMMDD-HHMMSS>.md` using
the Write tool. Never write to the repo working tree.

## Anti-patterns

- MUST NOT assume an unstated answer — ask.
- MUST NOT write `CONTEXT.md` to the repo working tree — only to `/tmp/`.
- MUST NOT skip the Step 4 gate even if the user seems satisfied.
