# Backlog Provider Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace runner-facing tracker coupling with canonical backlog, branch, and change provider contracts while preserving legacy CLI behavior.

**Architecture:** Add a provider bundle at the application boundary. GitHub/GitLab issue and label details stay inside adapters; `WorkflowRunner` orchestrates claim, branch, agent execution, change request, verification, and terminal backlog transition. Keep `ChangeProvider` and `BranchProvider`; do not add `BacklogExecutionService`.

**Tech Stack:** TypeScript, Vitest, existing `simple-git`, GitHub/GitLab clients.

---

### Task 1: Add canonical provider contracts

**Files:** Create `src/lib/core/backlog/types.ts`, `src/lib/core/backlog/index.ts`; create `src/lib/core/branches/provider.ts`; create `src/lib/core/changes/provider.ts`; modify barrel exports.

- [ ] Add the exact `BacklogItem`, state, mode, claim, transition, runnable, branch, and change interfaces from the design document.
- [ ] Add `deriveBacklogBranchName(id)` with slash-safe normalization and tests for numeric, UUID, and invalid IDs.
- [ ] Run `pnpm vitest run src/lib/core/backlog/provider.test.ts` and `pnpm typecheck`.

### Task 2: Implement legacy tracker adapter

**Files:** Create `src/lib/core/backlog/tracker-adapter.ts`; create `src/lib/core/changes/tracker-adapter.ts`; create `src/lib/core/branches/git-provider.ts`; tests beside each adapter.

- [ ] Map issue labels and descriptions to canonical state, mode, parent, and dependency fields.
- [ ] Implement atomic claim using a conditional read/update with a compare-and-set guard; return `null` on a lost race.
- [ ] Keep label writes exclusively inside the adapter and make canonical transitions idempotent.
- [ ] Implement branch/worktree/push via existing branch strategies and change operations via existing tracker MR methods.
- [ ] Run focused adapter tests.

### Task 3: Build provider bundle and request wiring

**Files:** Modify `src/lib/client-factory.ts`, `src/lib/workflows/run-request.ts`, `src/lib/workflows/run-cmd.ts`; create `src/lib/core/providers.ts`; tests.

- [ ] Add `ProviderBundle { backlog; branches; changes }` and construct it from the detected project without changing process cwd.
- [ ] Preserve `createTrackerClient()` and existing command signatures.
- [ ] Add backlog ID string support while accepting numeric `iid` as a compatibility alias.
- [ ] Verify provider selection and project-root propagation.

### Task 4: Make WorkflowRunner provider-aware

**Files:** Modify `src/lib/workflows.ts`, `src/lib/workflows/resource-scope.ts`, `src/lib/workflows/system-actions.ts`; tests.

- [ ] Add a dependency-injected provider bundle overload and normalize legacy tracker input to adapters.
- [ ] Claim before creating a branch; skip non-runnable items without mutating state.
- [ ] Derive/use the backlog branch through `BranchProvider`, create changes through `ChangeProvider`, and keep existing agent/template execution.
- [ ] Route every automation failure, conflict, timeout, and non-PASS verification to `blocked` plus `hitl` through the backlog provider.
- [ ] Ensure terminal transition is idempotent and never directly calls label APIs.

### Task 5: Migrate loop and QA ownership

**Files:** Modify `src/lib/modules/loop-runner.ts`, `src/lib/modules/qa-runner.ts`, `src/lib/scheduler.ts`; tests.

- [ ] Select work using `BacklogProvider.list()` and `claim()` rather than hard-coded label filters.
- [ ] Keep QA as a separate verification flow using `ChangeProvider`; merge only explicit `ac_result: PASS` and then transition backlog to `done`.
- [ ] Mark blocked/hitl for conflict, timeout, missing result, failed verification, and merge errors.

### Task 6: Compatibility, documentation, and full verification

**Files:** Update `docs/ARCHITECTURE*.md`, `docs/WORKFLOWS*.md`, `docs/EXECUTION-DESIGN*.md`, `CLAUDE.md`, and ADR-0015.

- [ ] Document provider ownership, canonical states, mode semantics, parent/dependency rules, and adapter label mappings.
- [ ] Add deprecation notes for direct `TrackerProvider` use in workflow modules.
- [ ] Run `pnpm typecheck`, `pnpm build`, `pnpm test -- --run`, and CLI help checks for source and dist.
- [ ] Review all changed code for direct label/platform SDK access outside adapters.
