# Backlog CLI Hard Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the issue/tracker-oriented CLI and runner paths with a single backlog/provider workflow, with no compatibility aliases, legacy branches, or platform-specific state logic outside adapters.

**Architecture:** `BacklogProvider` is the only task-state boundary and owns canonical state, execution mode, hierarchy, dependencies, atomic claim, and business tags. `BranchProvider` owns all branch/worktree operations; `ChangeProvider` owns change requests. CLI commands resolve a provider bundle and invoke application workflows. GitHub/GitLab are adapters only; their labels are internal persistence details.

**Tech Stack:** TypeScript, Commander, Vitest, `simple-git`, existing GitHub/GitLab SDK clients.

---

## Target command surface

```text
afk backlog init
afk backlog list [--state] [--mode] [--tag] [--parent]
afk backlog show --id <id>
afk backlog tag add --id <id> --tag <name>
afk backlog tag remove --id <id> --tag <name>
afk loop [loop options]
afk run --backlog-id <id> [execution options]
afk qa --backlog-id <id>
```

`afk backlog` is read/manage-only: it never starts an agent, creates a branch, or runs QA. `afk run` executes one implementation item. `afk loop` runs the complete automatic pipeline: claim → implementation → verification → QA → merge → done. `afk qa` independently invokes the same QA application service for manual execution, retry, or diagnosis. Remove `afk tracker`, `afk issue`, and the old workflow-oriented execution commands. Do not add aliases, deprecated parsers, dual request types, or `if (legacy)` branches. A breaking CLI release is intentional.

## Canonical domain rules

```ts
type BacklogState = 'ready' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';
type BacklogExecutionMode = 'afk' | 'hitl';

interface BacklogItem {
  id: string;
  title: string;
  description?: string;
  parentId?: string;
  dependsOn: string[];
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  tags: string[];
  branchName: string;
  providerRef: string;
}
```

Parents are never runnable. Every dependency must be `done`. Automation failure, conflict, timeout, missing result, and merge failure transition to `blocked` and set mode to `hitl`. `mode::afk` and `stage::*` never appear outside provider adapters.

## Task 1: Freeze the hard-cutover surface

**Files:** `src/index.ts`, `src/command-registry.ts`, `src/commands/*.ts`, CLI tests.

- [ ] Remove registration and implementations for `tracker`, `issue`, and old workflow execution commands.
- [ ] Register the read/manage-only `backlog` tree, preserve `loop`, and add top-level `run` and `qa` commands.
- [ ] Add CLI tests asserting removed commands return Commander “unknown command” errors rather than invoking compatibility code.
- [ ] Add help snapshots for every backlog subcommand, `afk loop`, `afk run --backlog-id`, and `afk qa --backlog-id`.

## Task 2: Complete canonical BacklogProvider

**Files:** `src/lib/core/backlog/index.ts`, `src/lib/core/backlog/types.ts`, `src/lib/core/backlog/tracker-adapter.ts`, tests.

- [ ] Add `tags: string[]` to `BacklogItem` and provider methods:

```ts
list(options?: { state?: BacklogState; executionMode?: BacklogExecutionMode; parentId?: string; tag?: string }): Promise<BacklogItem[]>;
addTag(id: string, tag: string): Promise<void>;
removeTag(id: string, tag: string): Promise<void>;
initialize(): Promise<void>;
```

- [ ] Map closed/merged provider records to `done` when no explicit canonical state exists.
- [ ] Reject construction of adapters without a real atomic claim capability; never fall back to a process-local mutex.
- [ ] Require the atomic capability to validate `ready`, execution mode, parent absence, and dependency completion in the same provider-side operation, or re-read and fail closed when the provider cannot guarantee that predicate.
- [ ] Keep all internal state-label creation/removal in the adapter.
- [ ] Test tags, closed dependencies, parent detection, dependency races, atomic claim loss, and idempotent transitions.

## Task 3: Provider initialization and tags

**Files:** Create `src/lib/core/backlog/initialization.ts`, `src/lib/core/backlog/tags.ts`; modify GitHub/GitLab adapters; tests.

- [ ] Define provider-owned internal mapping metadata for state/mode labels.
- [ ] Implement `initialize()` to create/validate required provider metadata without exposing label names in CLI output.
- [ ] Implement business tags as a provider-neutral string set; preserve user tags while updating internal metadata.
- [ ] Ensure `backlog init` is idempotent and reports provider capabilities, including whether atomic claim is available.

## Task 4: Replace request and CLI wiring

**Files:** `src/lib/workflows/run-request.ts`, `src/lib/workflows/run-cmd.ts`, create `src/lib/backlog/commands.ts`, `src/commands/backlog.ts`, modify `src/commands/loop.ts`, create `src/commands/run.ts`, `src/command-registry.ts`.

- [ ] Replace numeric `iid` with required string `backlogId` everywhere in new workflow requests.
- [ ] Remove `normalizeBranchStrategy` issue syntax and all `issue:<iid>` defaults.
- [ ] Resolve `targetBranch`, `baseBranch`, execution mode, agent, sandbox, provider bundle, and template in one backlog request resolver.
- [ ] Make `run --backlog-id` claim through `BacklogProvider` before branch creation.
- [ ] Keep `backlog` handlers strictly read/manage-only; reject execution options under `afk backlog`.
- [ ] Make `loop` resolve the provider bundle and repeatedly claim runnable items.
- [ ] Make `qa --backlog-id` resolve a `verification` item without re-running implementation.
- [ ] Make `backlog init` the only command that prepares provider metadata.

## Task 5: Make WorkflowRunner provider-only

**Files:** `src/lib/workflows.ts`, `src/lib/workflows/resource-scope.ts`, `src/lib/workflows/system-actions.ts`, tests.

- [ ] Change the constructor to require `ProviderBundle`; remove `TrackerProvider` from runner dependencies.
- [ ] Create and clean primary and step worktrees only through `BranchProvider`.
- [ ] Create/push/merge changes only through `ChangeProvider`.
- [ ] Remove all direct label, platform, issue, MR, and tracker calls from the runner.
- [ ] Ensure every post-claim exception, template failure, sandbox failure, timeout, conflict, handoff exhaustion, and system-action failure reaches one terminalizer that transitions `blocked/hitl`.
- [ ] Ensure successful execution reaches `verification` or `merge_ready`, never `done` before QA.
- [ ] Test repeated finish, claim failure, branch conflict, provider failure, and cleanup ownership.

## Task 6: Make templates and plugins provider-neutral

**Files:** `src/lib/templates/compiler.ts`, `src/lib/templates/types.ts`, `src/lib/workflows/plan-executor.ts`, `src/lib/plugins/runtime.ts`, tests.

- [ ] Honor typed step `completion`, `provider`, `executionMode`, `dependsOn`, `when`, and branch declarations in production execution.
- [ ] Route agent steps through `AgentExecutionService` and system steps through `SystemActionExecutor`.
- [ ] Construct `PluginRuntime` from the resolved project and pass it to lifecycle, agent, sandbox, and system-action dispatch.
- [ ] Allow plugin-registered system actions after capability validation; reject unknown actions before any resource is created.
- [ ] Keep failed ordinary dependencies from running; allow explicit recovery steps with `when` predicates.

## Task 7: Refactor loop and standalone QA

**Files:** `src/lib/modules/loop-runner.ts`, `src/lib/modules/qa-runner.ts`, `src/lib/scheduler.ts`, tests.

- [ ] Preserve `afk loop` as the complete pipeline executor while replacing label polling with `BacklogProvider.list({ state: 'ready', executionMode: 'afk' })` and provider-side runnable filtering.
- [ ] Use string backlog IDs end-to-end; derive sessions and branches from the backlog ID, not platform names or numeric coercion.
- [ ] Resolve module activation through provider-neutral metadata/tags, not raw issue labels.
- [ ] `afk qa --backlog-id` consumes only `verification` items, uses `BranchProvider` for merge worktrees, finds changes through `ChangeProvider`, and merges only explicit `ac_result: PASS`.
- [ ] `afk loop` invokes the same QA application service after implementation and owns the full automatic state progression through `done`.
- [ ] Standalone `afk qa` must share the exact QA service and terminal rules used by `afk loop`; it must not fork a second QA implementation.
- [ ] All QA failure classes transition to `blocked/hitl`; only successful merge transitions `done`.

## Task 8: Remove obsolete platform execution code

**Files:** `src/lib/core/tracker/**`, `src/lib/client-factory.ts`, obsolete command modules, imports and tests.

- [ ] Delete `TrackerProvider` from execution-layer exports; retain platform clients only as adapter dependencies.
- [ ] Remove direct platform detection from workflow/loop/QA modules.
- [ ] Delete old label constants from application modules; keep mappings in adapter files only.
- [ ] Remove obsolete `issue`, `tracker`, `workflow`, and `qa` command tests and replace them with backlog command tests.

## Task 9: Documentation and migration notice

**Files:** `CLAUDE.md`, `docs/ARCHITECTURE*.md`, `docs/WORKFLOWS*.md`, `docs/EXECUTION-DESIGN*.md`, ADR-0015.

- [ ] Document the breaking CLI change prominently.
- [ ] Document canonical state/mode/tag semantics and provider capability requirements.
- [ ] Document that labels are adapter-internal and that no compatibility aliases exist.
- [ ] Add a provider capability matrix: atomic claim, tags, branch lifecycle, change merge, QA verification.

## Verification and acceptance

Run after every task and again at the end:

```bash
pnpm typecheck
pnpm build
pnpm exec vitest run
node dist/index.js backlog --help
node dist/index.js loop --help
node dist/index.js run --help
node dist/index.js qa --help
node dist/index.js backlog tag --help
```

Acceptance requires that `rg` finds no `stage::`, `mode::`, `TrackerProvider`, `getIssue`, `listMRs`, or platform SDK references in workflow/loop/QA application modules; all provider adapters and tests remain green.
