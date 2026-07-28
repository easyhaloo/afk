---
name: afk-prototype
description: >-
  Use when requirements are confirmed but technical risk needs validation
  before committing to full build. Time-boxed spike to prove feasibility.
  Produces draft MR + findings report.
disallowed-tools: >-
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(git push -f)
  Bash(git reset --hard*) Bash(git branch -D*)
---

# Prototype / tracer bullet

**Goal:** prove the riskiest part end-to-end, thin but through every
touched layer — not a complete feature.
**Mode:** HITL-led — human steers in-session; agent executes each step.
**Contract:** aligned requirements (any format) → draft MR (spike, unmerged) + findings.

## Preconditions

The caller has a **technical question to validate** with a defined
target outcome. Required inputs (any format):

- The question being answered (e.g. "does X work with Y?")
- The success criterion (e.g. "Y accepts X and returns Z")
- Target branch for the spike MR

If requirements aren't aligned yet, STOP — the caller should clarify
intent first via whatever interview process they use.

## Time-boxing & disposal

- **Default budget:** one working session (a few hours).
- **Stop signal:** the instant the riskiest unknown has a concrete answer
  (works / doesn't work / needs X), stop building.
- **Disposal stance:** default to deleting the spike branch once findings
  are captured. Keep only if the PRD needs to cite specific lines.
- **Duplicate-effort check:** before branching, check for existing
  `spike/*` branches or draft MRs touching the same area.

## Steps

1. `git checkout -b spike/<slug>`
2. Build the smallest slice exercising the full path end to end.
   Skip edge cases, error-handling polish, tests beyond confirming the approach.
3. `git push -u origin spike/<slug>` then create a **Draft MR**:
   ```bash
   glab mr create --target-branch <target_branch> --draft --yes
   ```
4. Report: what worked, what surprised you, PRD implications.
5. Gate: human decides when the spike has answered the open question.

## Anti-patterns

- MUST NOT let spike code become the real implementation.
- MUST NOT skip this phase for real technical risk to save time.
