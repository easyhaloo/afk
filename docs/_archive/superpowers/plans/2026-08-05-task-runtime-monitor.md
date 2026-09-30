# Task Runtime Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a filesystem-backed runtime monitor for active AFK workflow and QA executions, and use it as the sole Tasks TUI data source.

**Architecture:** `TaskRuntimeStore` atomically persists active records and archives terminal ones. `TaskRuntimeManager` offers lifecycle operations and stale-heartbeat classification. Workflow and QA runners create/update/finish records; the dashboard converts active runtime records into task view models without inspecting tmux or backlog state.

**Tech Stack:** TypeScript, Node filesystem APIs, React Ink, Vitest.

---

### Task 1: Add runtime storage

**Files:**
- Create: `src/lib/runtime/task-runtime.ts`
- Test: `src/lib/runtime/task-runtime.test.ts`

- [x] Write tests for atomic start/update/archive and stale heartbeat classification.
- [x] Run `pnpm exec vitest run src/lib/runtime/task-runtime.test.ts` and observe missing-module failure.
- [x] Implement `TaskRuntimeStore` and `TaskRuntimeManager` using active/archive directories and atomic JSON writes.
- [x] Re-run the focused test until it passes.

### Task 2: Connect execution lifecycles

**Files:**
- Modify: `src/lib/workflows.ts`
- Modify: `src/lib/modules/qa-runner.ts`
- Test: `src/lib/workflows/backlog-provider.test.ts`
- Test: `src/lib/modules/qa-runner.test.ts`

- [x] Add failing tests proving workflow and QA create, phase-update, heartbeat, and terminalize runtime records.
- [x] Run the two focused suites and observe the missing lifecycle calls.
- [x] Inject the runtime manager as an optional runner dependency and route all success, failure, timeout, and cleanup paths through it.
- [x] Re-run both suites until they pass.

### Task 3: Replace the Tasks read model

**Files:**
- Modify: `src/types/board.ts`
- Modify: `src/views/board/data/fetcher.ts`
- Modify: `src/views/board/data/useData.ts`
- Modify: `src/views/app/DashboardEntry.tsx`
- Modify: `src/views/app/AppContent.tsx`
- Modify: `src/views/board/views/TaskListView.tsx`
- Modify: `src/views/board/views/DetailScreen.tsx`
- Modify: `src/views/board/views/Footer.tsx`
- Modify: `src/views/board/views/HelpDialog.tsx`
- Test: `src/views/board/data/useData.test.ts`
- Test: `src/views/board/views/DetailScreen.test.tsx`

- [x] Add failing tests converting runtime records into Tasks without `TaskService` or tmux discovery.
- [x] Run the focused dashboard suites and observe the old read model failure.
- [x] Implement runtime task mapping, diagnostic opening, and interactive-only attach affordance.
- [x] Re-run the focused suites until they pass.

### Task 4: Verify the integrated monitor

**Files:**
- Test: `src/lib/runtime/task-runtime.test.ts`
- Test: `src/lib/workflows/backlog-provider.test.ts`
- Test: `src/lib/modules/qa-runner.test.ts`
- Test: `src/views/board/data/useData.test.ts`
- Test: `src/views/board/views/DetailScreen.test.tsx`

- [x] Run `pnpm exec vitest run` for all focused suites.
- [x] Run `pnpm typecheck`, `pnpm build`, `pnpm exec vitest run --exclude 'tests/e2e/**'`, and `git diff --check`.
