# Methodology Reference

> **Sync note:** this directory mirrors `afk-implement/references/` —
> both skills use the same methodology (TDD feature/refactor/hotfix/spike).
> When updating methodology, update both directories in the same commit.

Every AFK run starts by identifying the task type, then loading the
corresponding reference document. Read this file first to pick the right
mode.

## Task Type Quick Reference

| Task Type | Characteristics | Reference |
|-----------|-----------------|-----------|
| **Feature** | New behavior, API, UI, or data model | `tdd-feature.md` |
| **Refactor** | Improve code structure without changing behavior | `tdd-refactor.md` |
| **Research** | Investigate, compare, or evaluate options | `research.md` |
| **Hotfix** | Urgent patch for a live problem | `hotfix.md` |
| **Spike** | Evaluate feasibility or learn an unfamiliar system | `spike.md` |

## Task Type Detection Prompt

Before writing any code, read `git log --oneline -5` to understand the
current state, then ask yourself:

```
Is this task asking me to:
- ADD a new behavior or capability?          → Feature (tdd-feature.md)
- CHANGE how existing code is structured
  without changing what it does?             → Refactor (tdd-refactor.md)
- FIND information or evaluate options?      → Research (research.md)
- FIX a live bug under time pressure?        → Hotfix (hotfix.md)
- PROVE a technical approach works before
  committing to full implementation?         → Spike (spike.md)
```

If the task spans multiple types, load the dominant one and apply its
discipline. If unsure, default to `tdd-feature.md` — the most common case.

## Loading a Reference

At the start of a `/goal` run, after reading git log:

```bash
cat references/<appropriate-file>.md
```

The reference file tells you:
- What to do first (step sequence)
- What a good checkpoint looks like (commit format)
- What to watch out for (anti-patterns specific to that task type)
- When to escalate vs. iterate

## Always-In-Scope Files

| File | When to read |
|------|-------------|
| `references/hard-checks.md` | **Every run** — non-negotiable rules |

## Common Pitfalls

- **Treating a feature as research**: ends with a report but no implementation.
- **Treating a refactor as a feature**: scope creep, new behavior sneaking in.
- **Treating a hotfix as a feature**: over-engineering a temporary fix.
- **Skipping task identification**: jumping straight into code on a misidentified type.
- **Skipping hard-checks**: hard-checks exist precisely because warnings
  are not enough to prevent dangerous behavior in unattended runs.
