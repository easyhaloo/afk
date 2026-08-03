---
name: afk-to-issues
disable-model-invocation: true
description: >-
  Decompose requirements into tracker issues with machine-checkable
  acceptance criteria. Two entry points: an approved PRD with
  Observable Behaviors, or any requirement context in Direct Mode.
  Reads the codebase to choose verification means (test runner,
  HTTP endpoint, log file, manual check).
disallowed-tools: >-
  Bash(afk mr merge*)
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(gh issue delete*) Bash(gh repo delete*)
  Bash(git push -f) Bash(git reset --hard*) Bash(git branch -D*)
---

# Requirements -> Issues

**Goal:** Independently pickable tracker issues with verifiable completion conditions.
**Mode:** HITL-gated — draft first, approve before creating.

## Mode Decision

| Mode | Input | Trigger |
|------|-------|---------|
| **PRD Mode** | `PRD.md` `## User Stories` with Observable Behavior lists | An approved PRD exists |
| **Direct Mode** | Any requirement context (free text / notes / chat) | No PRD, or fast path |

Mode propagates to labels: `mode::afk` (autonomous) or `mode::hitl` (human-in-the-loop).
Base label: `base::prd-<iid>` (PRD Mode) or `base::direct` (Direct Mode).

## Verification Inference

For each Observable Behavior (PRD) or requirement clause (Direct), read the
codebase to infer:

1. **What proves the behavior** — locate test runner, HTTP route, log format, or module
2. **What `evidence_type` fits** — controlled vocabulary: `test` | `curl` | `log` | `manual` | `none`
3. **What `check_command` exits 0 on PASS** — concrete shell snippet

If no signal found → default to `manual`, flag as "needs automated check".
Allowed tools: Read, Grep, Bash (read-only only).

## Slice Strategy

1. Analyze: count distinct domains, layers, team ownership lines
2. Infer strategy:
   - One team, end-to-end → **Vertical** (default)
   - Multiple teams, layer ownership → **Horizontal**
   - Unclear → ask user
3. Tell user which strategy and why

| Strategy | Shape | Best when |
|----------|-------|-----------|
| **Vertical** | model+API+logic+test in one issue | Single team |
| **Horizontal** | one issue per layer (API, DB, UI) | Layer-owned teams |

## Slicing Rules

- **Too big:** AC > ~5 lines, or touches > ~3 modules → split
- **Too small:** no user-observable behavior → fold or mark tech-debt
- **Cycle check:** trace `blocked_by` graph; redraw if cyclic
- **Direct Mode:** ask user to narrow if too large

## Isolate Analysis

For each slice, check for: schema change, middleware config change, new middleware dependency.
If any matches → mark slice `need::isolate: true`.

## Issue Body Composition

Fields per `references/issue-template.md`:
- `# <Title>` — PRD story title or Direct Mode title
- `## Context` — problem statement from PRD or paraphrased
- `## Acceptance Criteria` — one per Observable Behavior, 3-field format: `<text> -- <evidence_type> -- <check_command>`
- `## Out of Scope` — from PRD or inferred
- `## Dependencies` — DAG edges from `blocked_by`; `none` if standalone

## Steps

### 1. Pick mode

PRD exists → PRD Mode. Else → Direct Mode. Lock in labels:
- `mode::afk` or `mode::hitl`
- `base::prd-<iid>` or `base::direct`

### 2. Read inputs + read codebase

Apply Verification Inference per Observable Behavior (PRD) or requirement clause (Direct).
Output: AC list in 3-field format.

### 3. Slice + Cross-Project Dispatch

Apply Slice Strategy + Slicing Rules.
If requirement spans multiple repos: per slice, decide target repo → `--project <repo>` flag.
If strategy ambiguous → ask user.

### 4. Isolate Analysis

Apply Isolate Analysis per slice. Set `need::isolate` label if middleware signals found.

### 5. Compose drafts

Fill every Issue Body Composition field per slice. `none` for empty Dependencies.

### 6. Self-quality-gate

Run every `check_command` in sandbox. Non-zero exit or vocabulary violation → fix draft before proceeding.

### 7. HITL gate

Present all drafts + DAG + label scheme + `need::isolate` decisions.
Wait for explicit approval. Do not proceed until user confirms.

### 8. Create

On approval:
```
afk issue create --label stage::ready-for-issues --label <mode> --label <base> [--label need::isolate]
afk issue link <iid> <blocked-by-iid>
```
For cross-project: `--project <owner/repo>` and `<project>:<iid>` syntax for linking.

## References

Always read `references/issue-template.md` — defines the AC schema and body fields.

## Caveats

- AC without `-- <evidence_type> -- <check_command>` suffix
- `evidence_type` chosen without reading codebase (guessing forbidden)
- `evidence_type` outside controlled vocabulary
- `check_command` with no exit-code contract or mutating state
- Skipping Step 6 self-quality-gate
- Creating issues before Step 7 approval
- `mode::afk` for cross-context or mid-flight product decisions
- Forgetting `need::isolate` — loop won't start isolated containers without it
