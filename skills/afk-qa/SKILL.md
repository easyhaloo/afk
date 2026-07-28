---
name: afk-qa
description: >-
  Use when an MR from autonomous build needs independent verification
  against its Acceptance Criteria before merge. Verifies AC independently,
  merges if all pass, escalates if not.
disallowed-tools: >-
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(gh issue delete*) Bash(gh repo delete*)
  Bash(afk mr merge*)
  Bash(git reset --hard*) Bash(git branch -D*)
---

# QA

**Goal:** independent verification of autonomous build output against
Acceptance Criteria before merge into `prd/<N>`.
**Mode:** AFK (verification + merge) — HITL (`prd/<N>` → `main`).

**Architecture:**
```
prd/<N>  ← integration branch
    ↑
afk/issue-<iid>  (MR: afk/issue-<iid> → prd/<N>)
    ↑
main  ← only touched at final human gate
```

## Two merge gates

| Gate | Who | What | When |
|------|-----|------|------|
| AFK gate | afk-qa agent | Merge → `prd/<N>` | After all AC pass |
| Human gate | Human | Merge `prd/<N>` → `main` | After all MRs in PRD are merged |

## Preconditions

- MR in `stage::qa`, targeting `prd/<N>` (not `main`), with linked
  issue carrying `## Acceptance Criteria` using the 3-field `--` format.
- MR target branch is `prd/<N>` — if targeting `main` directly, STOP.

## Merge-order gate

MR description includes `## Merge Order` listing all `blocked_by` issues
with status. Before approving:
- **All blockers merged** → proceed to Step 4.
- **Any blocker unmerged** → do not merge. Post comment and leave in
  `stage::qa`.

## Signal vs. noise

- **Flaky checks:** fail on retry with no code change → note as flaky,
  move on. MUST NOT silently retry until green.
- **Non-functional AC:** "P95 < 200ms" without tooling → fail, not pass.
- **Self-report bias:** implementing agent's checklist is a hypothesis,
  not a substitute for independent re-run.

## Steps

### Step 1 — Read MR + AC

Open the MR. Read the linked issue's AC — the checklist, not code-review
taste. Note the `base::prd-<N>` label.

### Step 2 — Run AC checks fresh

Re-run every AC command/check independently. Do not trust the
implementing agent's self-report. Prefer MR's existing CI result over
re-deriving locally.

### Step 3 — Record per-line results

Per AC line: pass/fail + evidence (command output or response snippet).
If binary evidence was generated, write paths to `.afk/artifacts.txt`
(one absolute path per line).

### Step 4 — Merge to `prd/<N>` (all pass)

1. Approve the MR.
2. `afk mr merge <mr-id> --delete-source-branch`
3. Update labels: `stage::done`.
4. Discard DB fork if any.
5. **Check if this was the last open MR in the PRD** — if so, post on
   the PRD issue: "All issues merged. Ready for final human gate:
   merge `prd/<N>` → `main`."

### Step 5 — Conflict during merge

1. Post comment: "Merge conflict detected. Will attempt rebase."
2. Rebase on `prd/<N>`:
   ```bash
   git -C .worktrees/issue-<iid> fetch origin "prd/<N>"
   git -C .worktrees/issue-<iid> rebase origin/"prd/<N>"
   ```
   - **Text conflict resolved:** push, retry merge.
   - **Semantic conflict:** escalate to `mode::hitl`, leave MR in `stage::qa`.

### Step 6 — Any AC fail

Do not merge. Resume the autonomous build run. If failure reveals
mis-scoping: update labels to `stage::ready-for-issues` and involve human.

## Final human gate

When all MRs in a PRD are `stage::done`, human reviews `prd/<N>` and
decides whether to merge to `main`. Always HITL — no automation touches
`main`.

## Anti-patterns

- MUST NOT approve on "looks reasonable" — every AC line needs evidence.
- MUST NOT merge an MR targeting `main` directly.
- MUST NOT merge if any blocker in Merge Order is unmerged.
- MUST NOT discard a fork while build is still active.
- MUST NOT skip the final human gate.
