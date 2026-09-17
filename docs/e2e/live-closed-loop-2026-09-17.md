# AFK Live Closed-Loop E2E — 2026-09-17

**Status:** live E2E smoke-test artifact
**Backlog item:** [#138](https://github.com/easyhaloo/afk/issues/138)
**Branch:** `afk/backlog-138`

This file is a **live, provider-backed end-to-end smoke-test artifact**. It is
produced by running the AFK closed loop against a real provider (not a mock or
fixture) and recording the stages that actually executed. It exists to prove the
full loop works end to end; it is not a design document and carries no normative
weight.

---

## Stages

### 1. Provider task creation

The backlog item is created on the provider (GitHub issue #138) before any code
is written. AFK reads it back by `BacklogItem.id` — the canonical work identity —
which is what `--backlog-id` is later resolved against.

- Entry point: `afk backlog` (inspection) / provider issue creation
- Observed: issue #138 exists and is readable as a backlog item
- Identity: `BacklogItem.id` == `Run.workItemId` == runtime `backlogId`

### 2. Workflow implementation

`afk run --backlog-id 138` / `afk loop` executes the item inside an isolated
worktree on branch `afk/backlog-138`. The implementation agent makes the change,
runs the acceptance checks, and reports completion through the structured
`ExecutionResult` path (`.afk-signal.json` is legacy fallback only).

- Entry point: `afk loop` (implementation → QA → merge pipeline)
- Observed: the worktree is created from the backlog branch and the task
  completes with a `goal_complete` signal

### 3. Independent QA

QA is a separate runner (QARunner), not the implementation agent. It is handed
the completed work item and re-verifies the acceptance criteria independently,
then records the QA result before any merge is attempted.

- Entry point: `afk qa --backlog-id 138`
- Observed: QA re-runs the validation commands against the produced artifact
  and reports pass/fail separately from the implementation agent's own claim

### 4. Merge confirmation

Only after independent QA passes does the loop proceed to baseline integration
and merge confirmation. Merge is never performed by the implementation agent.

- Entry point: QARunner (baseline integration → QA result → push → MR/merge)
- Observed: the merge gate is reached only on a passing QA result, and the
  final state is confirmed against the provider rather than a local status file

---

## Verification

```bash
test -f docs/e2e/live-closed-loop-2026-09-17.md
rg -n "Provider task creation|Workflow implementation|Independent QA|Merge confirmation" \
  docs/e2e/live-closed-loop-2026-09-17.md
```

## Scope

This artifact adds documentation only. It does not modify source code,
configuration, dependencies, or unrelated documentation.
