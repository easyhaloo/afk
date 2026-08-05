# QA Rework And AC Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry diagnosable implementation AC failures inside one original-branch workflow, while persisting only cross-process QA failures as GitHub/GitLab rework records.

**Architecture:** `rework` is a claimable backlog state used only after QA fails with a complete diagnosis. Rework records are append-only provider comments/notes; the active record is injected into a new AFK run on the original backlog branch and resolved after the repaired requirement is verified. Original-branch AC verification stays inside the existing workflow: FAIL returns structured feedback to a bounded implement/verify loop without changing backlog state or creating a change request.

**Tech Stack:** TypeScript, Vitest, Octokit Issue comments, GitBeaker IssueNotes.

---

### Task 1: Define rework lifecycle and provider record contract

**Files:**
- Modify: `src/lib/core/backlog/index.ts`
- Modify: `src/lib/core/backlog/initialization.ts`
- Modify: `src/lib/core/backlog/claim-strategy.ts`
- Modify: `src/lib/core/backlog/management-provider.ts`
- Test: `src/lib/core/backlog/provider.test.ts`

- [ ] Add failing tests that claim `rework + afk`, append a record, and resolve it without deleting history.
- [ ] Extend canonical state/types and make `ready|rework` eligible for atomic or filesystem-protected claim.
- [ ] Run `pnpm vitest run src/lib/core/backlog/provider.test.ts`.

### Task 2: Persist QA records on GitHub and GitLab

**Files:**
- Create: `src/lib/core/backlog/rework-record.ts`
- Modify: `src/lib/core/tracker/types.ts`
- Modify: `src/lib/core/github/client.ts`
- Modify: `src/lib/core/gitlab/index.ts`
- Modify: `src/lib/core/backlog/tracker-adapter.ts`
- Test: `src/lib/core/backlog/tracker-adapter.test.ts`

- [ ] Add failing tests for tagged comment/note creation, loading the latest open record, and editing only that record to `resolved`.
- [ ] Implement one Markdown + JSON codec and tracker comment listing/update methods for both platforms.
- [ ] Run `pnpm vitest run src/lib/core/backlog/tracker-adapter.test.ts`.

### Task 3: Add bounded original-branch AC correction

**Files:**
- Modify: `src/lib/core/config/manager.ts`
- Modify: `src/lib/workflows/execution-protocol.ts`
- Modify: `src/lib/workflows.ts`
- Test: `src/lib/workflows/execution-protocol.test.ts`
- Test: `src/lib/workflows/backlog-provider.test.ts`

- [ ] Add failing tests for `goal_complete(kind=ac_verification, result=FAIL)` and a re-prompt using its diagnostic.
- [ ] Add `AFK_MAX_SELF_ITERATIONS` and loop implement/verify in the same worktree/branch until PASS or its configured bound.
- [ ] Route malformed diagnostics, timeout, conflict, or an exhausted loop to `blocked + hitl`; do not create a QA worktree or change request on AC FAIL.
- [ ] Run `pnpm vitest run src/lib/workflows/execution-protocol.test.ts src/lib/workflows/backlog-provider.test.ts`.

### Task 4: Route cross-process QA failure through rework

**Files:**
- Modify: `src/lib/modules/qa-runner.ts`
- Modify: `src/lib/modules/loop-runner.ts`
- Test: `src/lib/modules/qa-runner.test.ts`
- Test: `src/lib/modules/loop-runner.test.ts`

- [ ] Add failing tests that QA FAIL with structured criteria creates a provider record and transitions `rework + afk`.
- [ ] Enforce a bounded automatic QA rework count; after the limit transition `blocked + hitl`.
- [ ] Inject the active QA record into the next implementation prompt, resolve it only after requirement verification succeeds, and ensure root PR creation only occurs after QA PASS.
- [ ] Run `pnpm vitest run src/lib/modules/qa-runner.test.ts src/lib/modules/loop-runner.test.ts`.

### Task 5: Document and verify

**Files:**
- Modify: `docs/WORKFLOWS.md`
- Modify: `docs/ARCHITECTURE.md`

- [ ] Document the two different feedback loops and cross-platform comment/note representation.
- [ ] Run `pnpm vitest run && pnpm typecheck && pnpm build && git diff --check`.
