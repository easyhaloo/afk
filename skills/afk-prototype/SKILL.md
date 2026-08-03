---
name: afk-prototype
disable-model-invocation: true
description: >-
  Generate product prototypes or technical spikes.
  - product: HTML pages from vague requirements → iterate until confirmed
  - spike: prove technical feasibility → draft MR + findings
disallowed-tools: >-
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(gh pr merge*) Bash(gh issue delete*)
  Bash(gh pr delete*) Bash(gh repo delete*) Bash(git push -f)
  Bash(git reset --hard*) Bash(git branch -D*)
---

# Prototype

## product — want to see before building

**When:** requirements vague; visual confirmation before docs/code.
**Output:** `docs/prototype/<slug>/` containing index.html and README.md.

**Steps:**

1. Ask: single page or multi-page flow? Style reference?
2. Generate HTML (plain / React+Tailwind / Vue — match the ask).
3. Open file or serve dir → browser auto-opens.
4. Human reviews → feedback → revise → re-open.
5. Repeat until confirmed, then capture screenshots.

---

## spike — prove technical risk

**When:** requirements confirmed, tech approach unknown.
**Precondition:** approved `CONTEXT.md` exists.
**Output:** draft MR/PR + findings.

**Steps:**

1. Create spike branch.
2. Build smallest end-to-end slice (no polish).
3. Create draft MR.
4. Report findings: works / doesn't / needs X.
5. Gate: human decides when answered.

**Disposal:** delete branch after findings captured.

## Caveats

- MUST NOT proceed without user confirmation at each iteration (product).
- MUST NOT skip the approved CONTEXT.md precondition (spike).
- MUST NOT leave spike branch after findings captured.
