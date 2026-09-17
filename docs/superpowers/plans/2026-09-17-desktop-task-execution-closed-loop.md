# AFK Desktop 单任务执行闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Desktop 通过受限 `afk loop` 完成单个既有 Backlog 的执行、QA、人工恢复、重试和根任务合并闭环，并删除 `afk-pipeline`。

**Architecture:** Provider Backlog 继续作为业务状态真源，runtime record 作为执行状态真源，Desktop run store 只记录本地进程。Electron 仅调用固定参数的 AFK CLI；核心新增模板透传和三类意图型生命周期命令，Renderer 只通过 typed preload API 操作。

**Tech Stack:** TypeScript、Commander、Vitest、Electron、React、Zod、现有 Provider/WorkflowRunner/TemplateLoader。

---

## File Map

- Core loop template selection: `src/cli/commands/loop-options.ts`, `src/cli/commands/loop.ts`, `src/application/modules/loop-runner.ts` and focused tests.
- Core lifecycle intents: `src/domain/backlog/rework-record.ts`, `src/domain/backlog/commands.ts`, `src/cli/commands/backlog.ts` and focused tests.
- Desktop backend contract and process control: `desktop-client/shared/`, `desktop-client/electron/preload.ts`, `desktop-client/electron/ipc/register-handlers.ts`, `desktop-client/electron/services/backlog-execution-service.ts` and focused tests.
- Desktop renderer controls: `desktop-client/src/features/backlog/`, `desktop-client/src/main.tsx` and focused tests.
- Skill removal and docs: `skills/afk-pipeline/`, root/skills/docs READMEs, plugin manifests.

### Task 1: Remove `afk-pipeline`

**Files:**
- Delete: `skills/afk-pipeline/`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `skills/README.md`
- Modify: `docs/SKILLS.md`
- Modify: `docs/SKILLS_zh.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] Delete the skill directory and remove only references/registration entries for `afk-pipeline`.
- [ ] Run `rg -n "afk-pipeline|pipeline" README.md README_zh.md skills/README.md docs/SKILLS.md docs/SKILLS_zh.md .claude-plugin skills` and confirm no stale `afk-pipeline` reference remains.
- [ ] Do not change independent PRD, decomposition, scheduler, or execution skills.

### Task 2: Pass a Custom Template Through Scoped Loop

**Files:**
- Modify: `src/cli/commands/loop-options.ts`
- Modify: `src/cli/commands/loop-options.test.ts`
- Modify: `src/cli/commands/loop.ts`
- Modify: `src/application/modules/loop-runner.ts`
- Modify: `src/application/modules/loop-runner.test.ts`

- [ ] Add a failing option/parser test showing `afk loop --backlog-id task-1 --max-iterations 1 --template custom-review` yields `template: "custom-review"`.
- [ ] Add a failing runner test showing each selected backlog calls `WorkflowRunner.run()` with the explicit template while QA/rework behavior remains unchanged.
- [ ] Add the optional `--template <name>` flag and thread it through existing loop option types into `LoopRunner`.
- [ ] Reuse the existing `WorkflowRunner.run` template parameter and `TemplateLoader`; do not add snapshots, hashes, a second runner, or new storage.
- [ ] Run `./node_modules/.bin/vitest run src/cli/commands/loop-options.test.ts src/application/modules/loop-runner.test.ts`.

### Task 3: Add Intent-Specific Lifecycle Commands

**Files:**
- Modify: `src/domain/backlog/rework-record.ts`
- Modify: `src/domain/backlog/commands.ts`
- Modify or create focused test beside: `src/domain/backlog/commands.ts`
- Modify: `src/cli/commands/backlog.ts`
- Modify or create focused test beside: `src/cli/commands/backlog.ts`

- [ ] Extend `ReworkSource` minimally from `"qa"` to `"qa" | "operator"`.
- [ ] Add failing tests for `interrupt`: accept only `in_progress`/`verification`, then persist `blocked + hitl` with the supplied reason through existing Provider APIs.
- [ ] Add failing tests for `retry`: accept only `blocked + hitl`, write an operator rework record with empty failed criteria/checks, then persist `rework + afk`.
- [ ] Add failing tests for `confirm-merge`: accept only root `merge_ready + hitl`, verify the linked change through existing ChangeProvider operations, merge it, verify merged state, then persist `done`.
- [ ] Expose `afk backlog interrupt --id <id> --reason <text>`, `retry`, and `confirm-merge --id <id>` with the repository's existing JSON output/error conventions.
- [ ] Do not add generic state mutation, a recovery model, or direct label editing.
- [ ] Run the focused domain and backlog CLI tests with `./node_modules/.bin/vitest run <test-files>`.

### Task 4: Add Desktop Backend Controls

**Files:**
- Modify: `desktop-client/shared/backlog-contract.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/services/backlog-execution-service.ts`
- Modify focused tests under matching `desktop-client` directories.

- [ ] Change start arguments from `afk run --backlog-id <id>` to `afk loop --backlog-id <id> --max-iterations 1`, appending `--template <name>` only when selected.
- [ ] Add strict shared DTOs and preload methods for `stop`, `recover`, `retry`, and `confirmMerge`; keep shared files free of Electron/Node/React runtime dependencies.
- [ ] Implement stop as `SIGTERM`, bounded wait, optional `SIGKILL`, state refresh, then `afk backlog interrupt` only if Provider remains `in_progress`/`verification`.
- [ ] Implement stale recovery with a second PID/runtime freshness check before invoking `interrupt`.
- [ ] Implement retry as `afk backlog retry` followed by a new scoped loop using the selected/default prior template.
- [ ] Implement merge confirmation through `afk backlog confirm-merge`.
- [ ] Validate sender origin, workspace, backlog ID, template ID, and reason; never accept arbitrary commands or shell strings.
- [ ] Keep `electron/main.ts` unchanged except composition if strictly required; place behavior in the existing service/IPC modules.
- [ ] Run focused Desktop tests with `desktop-client/node_modules/.bin/vitest run <test-files>`.

### Task 5: Complete the Desktop Renderer Loop

**Files:**
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx`
- Modify: `desktop-client/src/features/backlog/backlog.css`
- Modify: `desktop-client/src/main.tsx`
- Modify focused renderer tests under `desktop-client/src/`.

- [ ] Add one primary action selected from current state: start, view, stop-and-handoff, recover-stale, retry, confirm merge, or view result.
- [ ] Add a lightweight start/retry confirmation with backlog identity, template selection/source/steps, default agent, and one launch button; do not add a wizard.
- [ ] Keep Provider, runtime, and local process data in separate detail sections.
- [ ] Show `确认合并` only for root `merge_ready + hitl` tasks with a linked change.
- [ ] Rename the custom workflow `qa` node display label to `审查 Agent` without adding a new node type.
- [ ] Use only the typed preload API; no Node/Electron/local I/O imports in React.
- [ ] Run focused renderer tests with `desktop-client/node_modules/.bin/vitest run <test-files>`.

### Task 6: Integration Validation

**Files:**
- Verify all files changed by Tasks 1-5.

- [ ] Review each task against `docs/superpowers/specs/2026-09-17-desktop-task-execution-closed-loop-design.md` and remove unrequested abstractions.
- [ ] Run focused tests first, then `./node_modules/.bin/tsc --noEmit`, root build, Desktop typecheck/build, and the relevant broader Vitest suites.
- [ ] Run `git diff --check` and inspect `git status --short`.
- [ ] Report pre-existing architecture-check violations separately; do not repair unrelated violations.

## Self-Review

- Spec coverage: scoped loop, custom template, stop, stale recovery, retry, root merge confirmation, UI actions, security boundaries, and pipeline removal are each assigned.
- Placeholder scan: no deferred implementation steps or unspecified error handling remain.
- Type consistency: Desktop method names are `start`, `stop`, `recover`, `retry`, and `confirmMerge`; CLI intent names are `interrupt`, `retry`, and `confirm-merge`.
- Ponytail check: reuses current Provider, TemplateLoader, WorkflowRunner, QARunner, runtime projection, and CLI execution paths; adds no daemon, snapshot store, generic state editor, or renderer I/O.

## Validation Results

- Core typecheck and build passed on September 17, 2026.
- Core focused integration suite passed: 9 files, 65 tests.
- Desktop typechecks and production renderer build passed.
- Desktop full suite passed: 41 files, 422 tests.
- Desktop Playwright suite passed: 36 tests, including a real Electron/Preload/IPC flow from `ready + afk` through implementation, independent QA, `merge_ready + hitl`, merge confirmation, and `done`.
- `git diff --check` passed; active code, docs, manifests, and skills contain no stale `afk-pipeline` reference.
- Root full Vitest run still has unrelated pre-existing failures in claim timing, streaming process-group timing, board rendering, project-list rendering, completion top-level `observe`, and a Git integration timeout. Task-related contract failures were updated and now pass.
- Architecture guard still reports the same 14 pre-existing violations documented before implementation; no new violation points at the files introduced by this change.
