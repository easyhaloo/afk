---
name: afk-research
description: >-
  Use when existing code, system, or approach needs to be understood
  before committing to a plan. Outputs findings doc or spike summary.
  HITL (guided) or AFK (self-directed) based on scope.
disallowed-tools: >-
  Edit(*) Write(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*)
---

# Research / Spike

**Goal:** understand how an existing system works, or evaluate feasibility
of an approach, before committing to a plan.
**Mode:** HITL (guided exploration) or AFK (self-directed with checkpoints).
**Contract:** (none) → `RESEARCH.md` + `stage::research`.

## Research modes

| Mode | When to use | Checkpoint cadence |
|------|-------------|-------------------|
| **HITL** | Unknown scope, high rabbit-hole risk, user guides direction | After every significant finding |
| **AFK** | Bounded scope, clear success criteria | Per WIP commit |

If the user says "look into X" without a scope limit, default to HITL.

## Spike vs. Research

- **Spike:** prove something works or doesn't. Yes/no with evidence,
  or minimal working example. Bounded time box (e.g. 2h).
- **Research:** understand a system or pattern. Structured findings doc
  covering components, relationships, and open questions.

## Progress checkpoints (AFK mode only)

```bash
git add -A && git commit -m "$(cat <<'EOF'
research: <short description>

Findings:
- <what was learned>
- <open questions>

Next: <concrete next action>
EOF
)"
```

## Steps

### Step 1 — Scope the research

Bounded question → scope is fixed. Unbounded question → use HITL and
confirm scope before diving in.

Define:
- **What we need to know** (questions to answer)
- **What we do NOT need to know** (boundaries)
- **Key files / modules / systems to read**

### Step 2 — Run mode

**HITL:** after each major component, show brief finding summary and ask:
"Continue in this direction, or pivot?" Stop when user says questions
are answered.

**AFK:** read files, run commands, take notes. Commit per checkpoint.
Show 1-line summary after each WIP commit.

### Step 3 — Synthesize

Write `RESEARCH.md`:
- **Context** — why this research was needed
- **Findings** — what was discovered, with file/function references
- **Implications** — what this means for downstream
- **Open questions** — what wasn't answered and still needs a decision

### Step 4 — Gate: user reviews findings

Show the full `RESEARCH.md`. User must confirm findings are complete
enough to proceed.

### Step 5 — Write + optional publish

Write `RESEARCH.md` to disk. Optional: post as a tracker issue
labeled `stage::research` via `afk issue create` if the tracker CLI
is authenticated.

## Anti-patterns

- MUST NOT make product decisions — only report findings.
- MUST NOT implement code beyond minimal spike proof-of-concept.
- MUST NOT rabbit-hole beyond the defined scope without permission.
- MUST NOT write `RESEARCH.md` to disk before Step 4 confirmation.
