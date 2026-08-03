---
name: afk-research
description: >-
  Understand how an existing system works, or evaluate feasibility
  of an approach, before committing to a plan.
  Outputs findings doc or spike summary.
disallowed-tools: >-
  Edit(*) Write(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*)
---

# Research / Spike

**Goal:** understand how an existing system works, or evaluate feasibility
of an approach, before committing to a plan.

## Dimensions

Two orthogonal dimensions define every research task:

| | Codebase | Web |
|--|----------|-----|
| **Survey** | Confirm a code assumption quickly | Confirm a solution exists quickly |
| **Investigate** | Deep-trace code to understand patterns | Multi-source cross-validation |

Choose one from each axis based on the question.

## Steps

### Step 1 — Classify the question

Ask: "Where is the source of truth for this answer?"

- **Code** → reference `codebase.md`
- **External** → reference `web-research.md`
- **Both** → start with the faster one to confirm, then the deeper one

### Step 2 — Set depth

- **Survey**: find the first credible answer, stop
- **Investigate**: explore multiple paths until confident

### Step 3 — Reason first, verify second

For each path:
1. State what you expect to find
2. Choose information source
3. Verify or disprove your expectation
4. Update mental model

### Step 4 — Synthesize

Present findings aligned with expectations.
Flag disconfirmed expectations — they are often the most valuable result.
See **Parallel execution** below for how to fan out across paths.

---

## Parallel execution

When multiple independent paths exist (e.g., surveying logging, error
handling, and state tracking in the same codebase), fan out to parallel
workers — each gets one path and returns a focused summary. Read the
conclusion, not the file dumps.

Use **parallel** execution for independent paths; use **sequential**
execution when one path's result narrows what the next should investigate.

For multi-step research with >3 verifiable phases, track progress with
task primitives so the user can see the work shape and resume across
interruptions. Mark tasks `in_progress` when starting, `completed` when
verified.

---

## Anti-patterns

- MUST NOT make product decisions — only report findings.
- MUST NOT implement code beyond minimal spike proof-of-concept.
- MUST NOT verify using the same source type as the initial assumption.
