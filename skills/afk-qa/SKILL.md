---
name: afk-qa
disable-model-invocation: true
description: >-
  Use when a backlog change request needs independent verification
  against its Acceptance Criteria before merge. Verifies AC independently,
  merges if all pass, and blocks the backlog if not.
disallowed-tools: >-
  Bash(git reset --hard*) Bash(git branch -D*)
---

# QA

**Goal:** independently verify a `verification` backlog item against its
Acceptance Criteria and merge its provider change only on an explicit pass.
**Mode:** AFK verification + merge; failures transition the item to
canonical `blocked` with `executionMode: hitl`.

**Architecture:** the provider maps each backlog ID to its implementation
branch and change request. Branch names, platform IDs, and provider labels
remain adapter details; this skill operates on the backlog ID only.

## Two merge gates

| Gate | Who | What | When |
|------|-----|------|------|
| AFK gate | afk-qa runner | Merge the provider change | After all AC pass |
| Human gate | Human | Release/integration decision | After all child backlogs are done |

## Preconditions

- Backlog is in `verification` and has a provider change request, with
  `## Acceptance Criteria` using the 3-field `--` format.
- The provider must expose a target branch/change that is safe to merge;
  if the change targets a protected release branch directly, STOP.

## Merge-order gate

Backlog dependencies define merge order. Before approving:
- **All `dependsOn` backlogs are `done`** → proceed to Step 4.
- **Any dependency incomplete** → do not merge; leave the item in
  `verification` and report the dependency.

## Signal vs. noise

- **Flaky checks:** fail on retry with no code change → note as flaky,
  move on. MUST NOT silently retry until green.
- **Non-functional AC:** "P95 < 200ms" without tooling → fail, not pass.
- **Self-report bias:** implementing agent's checklist is a hypothesis,
  not a substitute for independent re-run.

## Steps

### Step 1 — Read change request + AC

Open the provider change request. Read the backlog's AC — the checklist,
not code-review taste. Confirm its `dependsOn` entries and `verification`
state through `afk backlog show --id <id>`.

### Step 2 — Run AC checks fresh

Re-run every AC command/check independently. Do not trust the
implementing agent's self-report. Prefer the change request's existing CI result over
re-deriving locally.

### Step 3 — Record per-line results

Per AC line: pass/fail + evidence (command output or response snippet).
If binary evidence was generated, write paths to `.afk/artifacts.txt`
(one absolute path per line).

### Step 4 — Merge (all pass)

1. Approve the provider change request.
2. Ask `ChangeProvider` to merge the change after explicit `goal_complete` payload `kind: qa, result: PASS`.
3. Let `BacklogProvider` transition the item to `done`.
4. Discard DB fork if any.
5. **Check whether all child backlogs of the parent are now `done`** — if so,
   notify the human release owner.

### Step 5 — Conflict during merge

Post a diagnostic: "Merge conflict detected. Will attempt rebase."
Rebase on the provider target branch. Text conflict resolved → push, retry
merge. Semantic conflict → transition the backlog to `blocked` with
`executionMode: hitl`.

### Step 6 — Any AC fail

Do not merge. Keep the item in `verification` when a rerun is safe; otherwise
transition it to `blocked` with `executionMode: hitl` and involve a human.

## Final human gate

When all child backlogs under a parent are `done`, a human reviews the
provider's integration/release change and decides whether to release it.
Always HITL — no automation bypasses the configured release gate.

## Caveats

- MUST NOT approve on "looks reasonable" — every AC line needs evidence.
- MUST NOT merge a change targeting a protected release branch directly.
- MUST NOT merge if any `dependsOn` backlog is incomplete.
- MUST NOT discard a fork while build is still active.
- MUST NOT skip the final human gate.
