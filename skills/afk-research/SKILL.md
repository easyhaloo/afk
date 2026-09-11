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

Ask: "Where is the source of truth for this answer?" Code → codebase.
External → web-research. Both → start with faster one, then deeper.

**Output:** information source classified.

### Step 2 — Set depth

Survey: find first credible answer, stop. Investigate: explore multiple
paths until confident.

**Output:** depth set.

### Step 3 — Reason first, verify second

For each path: state expectation, choose source, verify or disprove,
update mental model.

**Output:** verified findings.

### Step 4 — Synthesize

Present findings aligned with expectations. Flag disconfirmed
expectations — they are often the most valuable result.

**Output:** synthesized findings doc.

---

## Parallel execution

Fan out independent research paths to parallel workers. Use **sequential**
when one path's result narrows the next. Track >3-phase progress with
task primitives (`in_progress` → `completed`).

---

## Caveats

- MUST NOT make product decisions — only report findings.
- MUST NOT implement code beyond minimal spike proof-of-concept.
- MUST NOT verify using the same source type as the initial assumption.
