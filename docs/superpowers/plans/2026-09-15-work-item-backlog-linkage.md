# Work Item and Backlog Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Backlog the single business source of truth, make every execution/runtime projection explicitly reference the same `backlogId`, and remove the current CLI and desktop contract drift.

**Architecture:** `BacklogItem` remains the canonical provider-facing work item. Each execution receives a separate `runId`, while `backlogId` is the stable join key between Provider state, workflow runs, runtime records, TUI tasks, observations, and Desktop views. The pure `core.WorkItem` model becomes an explicit projection of `BacklogItem`, not a second persistence model. The CLI and Desktop will use one typed contract and one authoritative command implementation.

**Tech Stack:** TypeScript, Commander, Vitest, GitHub/GitLab provider adapters, Electron IPC, React, JSONL run events, filesystem runtime records.

---

## Scope and non-goals

This plan covers the following independently testable sub-projects:

1. Canonical identity and model mapping.
2. CLI implementation consolidation and contract alignment.
3. Runtime/TUI projection alignment.
4. Desktop Backlog-to-runtime aggregation.
5. Documentation and rollout verification.

The plan does not introduce a new remote task-management provider, replace GitHub/GitLab storage, or redesign the workflow state machine beyond making its current mappings explicit.

The current repository has two parallel CLI trees. The authoritative public path will be the richer `src/cli/` implementation because it already contains `backlog create`, JSON envelopes, the newer `domain/application/infrastructure` split, and the Desktop-facing contract. The root dispatcher will delegate to that path; the older `src/commands/` modules remain only until migration tests prove they are unused, then are removed in a separate cleanup change.

## Target contract

The canonical relationship is:

```text
BacklogItem.id
  == CLI --backlog-id
  == Run.workItemId
  == TaskRuntimeRecord.backlogId
  == BoardTask.backlogId
  == Desktop BacklogRunSummary.backlogId
```

`runId` identifies one execution attempt and is never used as the business work-item identity.

The canonical lifecycle remains:

```text
ready + afk
  -> in_progress
  -> verification
  -> merge_ready / done

execution failure, timeout, lease loss
  -> blocked + hitl

QA failure
  -> rework + afk
```

`parentId` is organizational grouping, `dependsOn` is scheduling order, and `baseBacklogId` is the Git execution base. These fields must not be conflated.

## File map

### Canonical model and adapters

- Modify: `/Users/shenggangshu/llm/afk/src/domain/backlog/index.ts` — keep `BacklogItem` as the execution/provider contract and export the canonical state/mode types.
- Modify: `/Users/shenggangshu/llm/afk/src/core/model.ts` — make the pure core projection capable of representing Backlog lifecycle states without provider dependencies.
- Create: `/Users/shenggangshu/llm/afk/src/core/backlog-work-item.ts` — pure `BacklogItem` → `WorkItem` projection and reverse identity helpers.
- Create: `/Users/shenggangshu/llm/afk/src/core/backlog-work-item.test.ts` — exhaustive mapping tests.
- Modify: `/Users/shenggangshu/llm/afk/src/core/execution-base-policy.ts` — consume the explicit projection lineage without reading provider labels.
- Modify: `/Users/shenggangshu/llm/afk/src/core/execution-base-policy.test.ts` — verify `baseBacklogId` behavior through the canonical mapping.

### CLI consolidation

- Modify: `/Users/shenggangshu/llm/afk/src/index.ts` — route the public dispatcher to the authoritative CLI loader.
- Modify: `/Users/shenggangshu/llm/afk/src/lazy-loader.ts` — delegate command lookup to the authoritative registry or remove the duplicate loader after migration.
- Modify: `/Users/shenggangshu/llm/afk/src/full-cli.ts` — delegate full-command loading to the authoritative CLI registry.
- Modify: `/Users/shenggangshu/llm/afk/src/command-registry.ts` — preserve compatibility exports while sourcing registrations from `/Users/shenggangshu/llm/afk/src/cli/command-registry.ts`.
- Modify: `/Users/shenggangshu/llm/afk/src/cli/command-registry.ts` — make this the only public command registry.
- Modify: `/Users/shenggangshu/llm/afk/src/cli/lazy-loader.ts` — ensure nested command parsing works for `backlog create`, `backlog tag`, and `observe`.
- Modify: `/Users/shenggangshu/llm/afk/src/cli/commands/backlog.ts` — finalize JSON envelopes, create/list/show/tag behavior, and canonical field output.
- Modify: `/Users/shenggangshu/llm/afk/src/cli/commands/run.ts` — keep `--backlog-id` as the only execution identity flag.
- Modify: `/Users/shenggangshu/llm/afk/src/cli/commands/qa.ts` and `/Users/shenggangshu/llm/afk/src/cli/commands/loop.ts` — verify the same provider and state contract.
- Modify: `/Users/shenggangshu/llm/afk/src/command-registry.test.ts`, `/Users/shenggangshu/llm/afk/src/cli/command-registry.test.ts`, `/Users/shenggangshu/llm/afk/src/cli/commands/backlog.test.ts`, and `/Users/shenggangshu/llm/afk/src/cli/commands/loop.test.ts` — add public-surface and regression coverage.

### Runtime and TUI

- Modify: `/Users/shenggangshu/llm/afk/src/application/runtime/task-runtime.ts` — make the application runtime manager authoritative and add query helpers that filter runtime records by `backlogId` without changing the existing filesystem format.
- Modify: `/Users/shenggangshu/llm/afk/src/lib/runtime/task-runtime.ts` — replace the duplicate implementation with compatibility exports or migrate its consumers to the application runtime manager.
- Modify: `/Users/shenggangshu/llm/afk/src/types/board.ts` — expose `backlogId` as the primary field; retain `iid` only during the compatibility window.
- Create: `/Users/shenggangshu/llm/afk/src/views/board/data/work-item-projection.ts` — join canonical Backlog metadata with runtime records into the TUI view model.
- Create: `/Users/shenggangshu/llm/afk/src/views/board/data/work-item-projection.test.ts` — pure join and stale-runtime tests.
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/data/fetcher.ts` — use the projection helper and stop presenting a runtime-only identity.
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/views/BacklogRow.tsx`, `/Users/shenggangshu/llm/afk/src/views/board/board/BoardCard.tsx`, and related board tests — render `backlogId`, Backlog state, runtime phase, and run status distinctly.

### Desktop IPC and aggregation

- Modify: `/Users/shenggangshu/llm/afk/desktop-client/shared/backlog-contract.ts` — add typed runtime projection DTOs and strict parsers.
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/shared/ipc-contract.ts` — expose a typed Backlog detail/aggregate query.
- Create: `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-runtime-service.ts` — read Backlog data and local runtime/event projections in the Electron main process and join them by `backlogId`.
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-service.ts` — call the consolidated JSON CLI and normalize errors.
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-execution-service.ts` — preserve `backlogId`, `runId`, PID, and status while treating the local process store as launch metadata only.
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/electron/preload.ts` — expose only the new aggregate query through the fixed whitelist.
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/src/features/backlog/BacklogPage.tsx` and `/Users/shenggangshu/llm/afk/desktop-client/src/features/backlog/BacklogDetailDrawer.tsx` — show Backlog state separately from active runtime state.
- Create: `/Users/shenggangshu/llm/afk/desktop-client/tests/electron/backlog-runtime-service.test.ts` — service-level join, missing-runtime, stale-runtime, and malformed-record tests.
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/tests/shared/backlog-contract.test.ts`, `/Users/shenggangshu/llm/afk/desktop-client/tests/backlog-page.test.tsx`, and relevant E2E tests — verify the renderer contract.

### Documentation

- Modify: `/Users/shenggangshu/llm/afk/docs/ARCHITECTURE.md` — document Backlog as business SSOT and runtime as projection.
- Modify: `/Users/shenggangshu/llm/afk/docs/WORKFLOWS.md` — remove stale Issue-era lifecycle examples and use canonical `backlogId` commands.
- Modify: `/Users/shenggangshu/llm/afk/CLAUDE.md` — document the authoritative CLI path and Desktop contract.
- Modify: `/Users/shenggangshu/llm/afk/docs/OBSERVABILITY-HARNESS.md` — state how `workItemId` maps to `backlogId` and identify remaining coordinator boundaries.
- Modify: `/Users/shenggangshu/llm/afk/skills/afk-to-issues/SKILL.md` and `/Users/shenggangshu/llm/afk/skills/afk-implement/SKILL.md` — keep skill output and execution preconditions aligned with the canonical fields.

---

## Task 1: Establish a characterization baseline

**Files:**
- Test: `/Users/shenggangshu/llm/afk/src/command-registry.test.ts`
- Test: `/Users/shenggangshu/llm/afk/src/cli/command-registry.test.ts`
- Test: `/Users/shenggangshu/llm/afk/desktop-client/tests/electron/backlog-service.test.ts`
- Create: `/Users/shenggangshu/llm/afk/tests/contract/backlog-cli-desktop.test.ts`

- [ ] **Step 1: Record the current public command behavior**

Run:

```bash
pnpm exec tsx src/index.ts backlog --help
pnpm exec tsx src/index.ts backlog create --help
pnpm exec tsx src/index.ts backlog list --help
pnpm exec tsx src/index.ts run --help
pnpm build
node dist/index.js backlog --help
node dist/index.js backlog create --help
```

Expected baseline findings to capture in the test comments or plan issue:

- the root source path and built path must expose the same command set;
- `backlog create` and `--json` must be available to the Desktop service;
- `run` must accept `--backlog-id` and no tracker-specific replacement.

- [ ] **Step 2: Add a failing contract test for CLI/desktop argument compatibility**

The test must assert that the authoritative CLI exposes the exact argument arrays used by `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-service.ts` and `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-execution-service.ts`:

```ts
expect(buildCreateArgs({ title: 'Login', description: 'AC', tags: ['auth'], executionMode: 'afk' }, '/tmp/description.md'))
  .toEqual(['backlog', 'create', 'Login', '--description-file', '/tmp/description.md', '--mode', 'afk', '--tag', 'auth']);
expect(buildBacklogRunArgs({ backlogId: '123' }))
  .toEqual(['run', '--backlog-id', '123']);
```

- [ ] **Step 3: Run only the characterization tests**

```bash
pnpm exec vitest run src/command-registry.test.ts src/cli/command-registry.test.ts desktop-client/tests/electron/backlog-service.test.ts tests/contract/backlog-cli-desktop.test.ts
```

Expected: the test exposes the source/built CLI drift before implementation begins.

- [ ] **Step 4: Commit the baseline tests**

```bash
git add src/command-registry.test.ts src/cli/command-registry.test.ts desktop-client/tests/electron/backlog-service.test.ts tests/contract/backlog-cli-desktop.test.ts
git commit -m "test: capture backlog and runtime contract baseline"
```

## Task 2: Make the canonical model mapping explicit

**Files:**
- Modify: `/Users/shenggangshu/llm/afk/src/core/model.ts`
- Create: `/Users/shenggangshu/llm/afk/src/core/backlog-work-item.ts`
- Create: `/Users/shenggangshu/llm/afk/src/core/backlog-work-item.test.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/core/execution-base-policy.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/core/execution-base-policy.test.ts`

- [ ] **Step 1: Add failing projection tests**

Cover these exact cases:

```ts
it('maps Backlog identity and lineage without changing IDs', () => {
  const projected = toCoreWorkItem({
    id: '42', title: 'Login', state: 'ready', executionMode: 'afk',
    parentId: '10', baseBacklogId: '41', dependsOn: ['7'],
    tags: [], branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42',
  });
  expect(projected).toMatchObject({
    id: '42', title: 'Login', state: 'ready', mode: 'autonomous',
    lineage: { parentId: '10', baseWorkItemId: '41', dependsOn: ['7'] },
  });
});

it('maps human intervention and rework without losing the provider state', () => {
  expect(toCoreWorkItem(item({ state: 'blocked', executionMode: 'hitl' }))).toMatchObject({
    state: 'blocked', mode: 'human',
  });
  expect(toCoreWorkItem(item({ state: 'rework', executionMode: 'afk' }))).toMatchObject({
    state: 'rework', mode: 'autonomous',
  });
});

it('does not treat parentId or dependsOn as the Git execution base', () => {
  const projected = toCoreWorkItem(item({ parentId: '10', dependsOn: ['9'] }));
  expect(resolveExecutionBase(projected, () => undefined, 'main')).toEqual({
    branch: 'main', source: 'target',
  });
});
```

- [ ] **Step 2: Run the new tests and verify the failure**

```bash
pnpm exec vitest run src/core/backlog-work-item.test.ts src/core/execution-base-policy.test.ts
```

Expected: FAIL because no explicit Backlog-to-core projection exists and `rework` is not represented by the core state union.

- [ ] **Step 3: Implement the smallest pure adapter**

Add a function with this shape:

```ts
export function toCoreWorkItem(item: BacklogItem): WorkItem {
  return {
    id: item.id,
    title: item.title,
    state: mapBacklogState(item.state),
    mode: item.executionMode === 'afk' ? 'autonomous' : 'human',
    lineage: {
      parentId: item.parentId,
      dependsOn: [...item.dependsOn],
      baseWorkItemId: item.baseBacklogId,
    },
    revision: 0,
  };
}
```

Extend `WorkState` with `rework` rather than silently mapping it to `implementing`; this preserves the provider lifecycle in the pure model. Do not import GitHub, GitLab, labels, filesystem, Commander, or Electron into the adapter.

- [ ] **Step 4: Run the focused core tests**

```bash
pnpm exec vitest run src/core/backlog-work-item.test.ts src/core/execution-base-policy.test.ts src/core/reducer.test.ts
```

Expected: PASS, with no provider-label assertions in `src/core`.

- [ ] **Step 5: Commit the canonical mapping**

```bash
git add src/core/model.ts src/core/backlog-work-item.ts src/core/backlog-work-item.test.ts src/core/execution-base-policy.ts src/core/execution-base-policy.test.ts
git commit -m "feat: map backlog items into the core work model"
```

## Task 3: Consolidate the public CLI implementation

**Files:**
- Modify: `/Users/shenggangshu/llm/afk/src/index.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/lazy-loader.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/full-cli.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/command-registry.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/cli/command-registry.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/cli/lazy-loader.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/cli/commands/backlog.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/cli/commands/run.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/cli/commands/qa.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/cli/commands/loop.ts`
- Test: `/Users/shenggangshu/llm/afk/src/command-registry.test.ts`
- Test: `/Users/shenggangshu/llm/afk/src/cli/command-registry.test.ts`
- Test: `/Users/shenggangshu/llm/afk/src/cli/commands/backlog.test.ts`
- Test: `/Users/shenggangshu/llm/afk/src/cli/commands/loop.test.ts`

- [ ] **Step 1: Add a single-registry assertion**

Assert that both the root dispatcher and the full CLI load the same command names:

```ts
expect(rootCommandNames()).toEqual(cliCommandNames());
expect(cliCommandNames()).toEqual(expect.arrayContaining([
  'backlog', 'run', 'qa', 'loop', 'observe', 'completion', '__complete',
]));
```

Also assert that `backlog create`, `backlog tag add`, and `observe runs` are reachable through the public `dist/index.js` path.

- [ ] **Step 2: Run the registry tests and capture the failure**

```bash
pnpm exec vitest run src/command-registry.test.ts src/cli/command-registry.test.ts
```

Expected: FAIL because the root dispatcher still loads the parallel root command tree.

- [ ] **Step 3: Route the root dispatcher to `src/cli`**

Make the root entry point call the authoritative loader, while keeping compatibility exports for tests and downstream imports. The root path must not register two copies of a command.

The resulting public path must be:

```text
src/index.ts
  -> src/cli/lazy-loader.ts
  -> src/cli/command-registry.ts
  -> src/cli/commands/<command>.ts
```

- [ ] **Step 4: Normalize the Backlog JSON contract**

Every JSON-capable Backlog action must emit a structured envelope with:

```ts
type JsonEnvelope<T> = {
  ok: true;
  kind: string;
  data: T;
} | {
  ok: false;
  kind: string;
  error: { code: string; message: string };
};
```

The `data` payload for `backlog list`, `show`, `create`, and tag operations must use the canonical `BacklogItem` fields, including `id`, `parentId`, `baseBacklogId`, `dependsOn`, `state`, `executionMode`, `branchName`, and `providerRef`.

- [ ] **Step 5: Add the public CLI smoke test**

Run:

```bash
pnpm build
node dist/index.js backlog --help
node dist/index.js backlog create --help
node dist/index.js backlog list --help
node dist/index.js run --help
node dist/index.js qa --help
node dist/index.js observe --help
```

Expected: all commands resolve from one registry; `backlog create` and `--json` appear in the built CLI.

- [ ] **Step 6: Keep old command modules out of the public path**

Use `rg` to prove that `src/index.ts`, `src/lazy-loader.ts`, and `src/full-cli.ts` no longer import `src/commands/` directly. Do not delete the old tree in this task; mark it as compatibility-only in a code-level module note and remove it only after the full test suite passes in a later cleanup commit.

- [ ] **Step 7: Run focused CLI tests and commit**

```bash
pnpm exec vitest run src/command-registry.test.ts src/cli/command-registry.test.ts src/cli/commands/backlog.test.ts src/cli/commands/loop.test.ts
git add src/index.ts src/lazy-loader.ts src/full-cli.ts src/command-registry.ts src/cli/command-registry.ts src/cli/lazy-loader.ts src/cli/commands src/command-registry.test.ts
git commit -m "refactor: consolidate the backlog CLI entrypoint"
```

## Task 4: Make runtime projections queryable by `backlogId`

**Files:**
- Modify: `/Users/shenggangshu/llm/afk/src/application/runtime/task-runtime.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/lib/runtime/task-runtime.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/types/board.ts`
- Create: `/Users/shenggangshu/llm/afk/src/views/board/data/work-item-projection.ts`
- Create: `/Users/shenggangshu/llm/afk/src/views/board/data/work-item-projection.test.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/data/fetcher.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/data/useData.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/views/BacklogRow.tsx`
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/board/BoardCard.tsx`
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/data/fetcher.test.ts`
- Modify: `/Users/shenggangshu/llm/afk/src/views/board/board/BoardCard.test.tsx`

- [ ] **Step 1: Add runtime filtering tests**

Add a `listByBacklogId(backlogId: string)` test that returns all active and archived records for one canonical ID, excluding records for other IDs. Preserve the existing stale calculation based on `heartbeatAt`.

- [ ] **Step 2: Consolidate the runtime manager before changing the TUI**

The repository currently has both `/Users/shenggangshu/llm/afk/src/application/runtime/task-runtime.ts` and `/Users/shenggangshu/llm/afk/src/lib/runtime/task-runtime.ts`. First compare their public types and persistence behavior with the existing runtime tests. Make the application implementation authoritative, then either migrate legacy imports or make `/Users/shenggangshu/llm/afk/src/lib/runtime/task-runtime.ts` a compatibility re-export. Do not maintain two independent runtime stores.

Run:

```bash
rg -n "runtime/task-runtime" src
pnpm exec vitest run src/application/runtime/task-runtime.test.ts src/lib/runtime/task-runtime.test.ts src/views/board/data/fetcher.test.ts
```

Expected: both old and new consumers resolve to the same runtime record shape and filesystem behavior before the projection is added.

- [ ] **Step 3: Add the explicit TUI view model**

Use a view model with separate fields:

```ts
export type WorkItemProjection = {
  backlogId: string;
  title: string;
  backlogState?: BacklogState;
  executionMode?: BacklogExecutionMode;
  parentId?: string;
  dependsOn: string[];
  branch?: string;
  runId?: string;
  runStatus?: 'active' | 'stale' | 'completed' | 'blocked' | 'failed';
  phase?: 'implementing' | 'verifying';
  progress?: string;
  diagnosticPath?: string;
};
```

Do not use `iid` as the primary name in new code. Keep `iid` as a compatibility alias until all board consumers migrate.

- [ ] **Step 4: Implement the pure join**

The projection function must join by exact string equality:

```ts
export function projectWorkItem(backlog: BacklogItem | undefined, runtimes: TaskRuntimeRecord[]): WorkItemProjection {
  const latest = [...runtimes].sort((left, right) => right.heartbeatAt.localeCompare(left.heartbeatAt))[0];
  return {
    backlogId: backlog?.id ?? latest?.backlogId ?? '',
    title: backlog?.title ?? latest?.title ?? `Backlog ${latest?.backlogId ?? ''}`,
    backlogState: backlog?.state,
    executionMode: backlog?.executionMode,
    parentId: backlog?.parentId,
    dependsOn: [...(backlog?.dependsOn ?? [])],
    branch: latest?.branch ?? backlog?.branchName,
    runId: latest?.runId,
    runStatus: latest?.status,
    phase: latest?.phase,
    progress: latest?.progress,
    diagnosticPath: latest?.diagnosticPath,
  };
}
```

The function must handle missing Backlog metadata and missing runtime records without throwing.

- [ ] **Step 5: Update Board rendering and tests**

Render Backlog state and runtime phase as separate labels. A `blocked` Backlog with no active runtime must remain visible as a blocked Backlog, not disappear because there is no runtime record.

- [ ] **Step 6: Run focused TUI tests and commit**

```bash
pnpm exec vitest run src/application/runtime/task-runtime.test.ts src/lib/runtime/task-runtime.test.ts src/views/board/data/work-item-projection.test.ts src/views/board/data/fetcher.test.ts src/views/board/board/BoardCard.test.tsx
git add src/application/runtime/task-runtime.ts src/lib/runtime/task-runtime.ts src/types/board.ts src/views/board/data src/views/board/views/BacklogRow.tsx src/views/board/board/BoardCard.tsx
git commit -m "feat: project runtime tasks from canonical backlog IDs"
```

## Task 5: Add the Desktop Backlog/runtime aggregate

**Files:**
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/shared/backlog-contract.ts`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/shared/ipc-contract.ts`
- Create: `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-runtime-service.ts`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-service.ts`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/electron/services/backlog-execution-service.ts`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/electron/preload.ts`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/electron/ipc/register-handlers.ts`
- Create: `/Users/shenggangshu/llm/afk/desktop-client/tests/electron/backlog-runtime-service.test.ts`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/tests/shared/backlog-contract.test.ts`

- [ ] **Step 1: Define the cross-process aggregate DTO**

Add a runtime-neutral DTO:

```ts
export type BacklogRuntimeSummary = {
  backlogId: string;
  backlog: BacklogItem;
  activeRun?: BacklogRunSummary;
  runtime?: {
    runId: string;
    status: 'running' | 'stale' | 'completed' | 'blocked' | 'failed';
    phase: 'implementing' | 'verifying';
    progress?: string;
    branch?: string;
    worktree?: string;
    diagnosticPath?: string;
    heartbeatAt: string;
  };
};
```

The DTO must not import Node, Electron, React, DOM, or filesystem modules.

- [ ] **Step 2: Add strict parser tests**

Reject unknown fields and invalid states/statuses. Accept a missing `activeRun` and missing `runtime`, because a ready or completed Backlog can have no active execution.

- [ ] **Step 3: Implement the main-process join service**

The service must:

1. Resolve the workspace in the main process.
2. Load Backlog items through the existing CLI-backed service.
3. Load process launch records from `.afk/backlog-runs.json`.
4. Load runtime records from the canonical runtime store or its safe projection.
5. Match all records by `backlogId`, never by title, branch, PID, or array position.
6. Return a stable result when one source is missing or malformed.

Do not let the React renderer read `.afk`, invoke `afk`, or inspect local files directly.

- [ ] **Step 4: Add a fixed IPC method**

Expose one method such as:

```ts
backlog.summary(workspace: string, id: string): Promise<BacklogRuntimeSummary>
```

Validate `workspace` and `id` at the IPC boundary, and keep the preload whitelist typed and explicit.

- [ ] **Step 5: Reconcile run-start behavior**

Keep `.afk/backlog-runs.json` as launch metadata only. When the AFK process starts and writes a canonical runtime record, the aggregate view must prefer that runtime status over the local PID status. If the PID disappears before a runtime record exists, report `failed` with an explicit launch error; do not silently report `done`.

- [ ] **Step 6: Run Electron service and contract tests**

```bash
pnpm --dir desktop-client exec vitest run tests/electron/backlog-runtime-service.test.ts tests/electron/backlog-execution-service.test.ts tests/shared/backlog-contract.test.ts
```

Expected: PASS for matching, missing, stale, malformed, and process-exit cases.

- [ ] **Step 7: Commit the Desktop aggregate**

```bash
git add desktop-client/shared/backlog-contract.ts desktop-client/shared/ipc-contract.ts desktop-client/electron/services/backlog-runtime-service.ts desktop-client/electron/services/backlog-service.ts desktop-client/electron/services/backlog-execution-service.ts desktop-client/electron/preload.ts desktop-client/electron/ipc/register-handlers.ts desktop-client/tests
git commit -m "feat(desktop): join backlog and runtime projections"
```

## Task 6: Update the Backlog UI and runtime views

**Files:**
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/src/features/backlog/BacklogDetailDrawer.tsx`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/src/features/backlog/backlog.css`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/tests/backlog-page.test.tsx`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/tests/e2e/backlog-list.spec.ts`
- Modify: `/Users/shenggangshu/llm/afk/desktop-client/tests/e2e/backlog-create.spec.ts`

- [ ] **Step 1: Add a failing renderer test for separated status display**

Given one Backlog item with `state: 'verification'` and one active runtime with `phase: 'verifying'`, assert that the UI displays both:

```text
Backlog: 验证中
运行：验证执行中
```

Also assert that a `blocked` Backlog without a runtime still renders its details and does not show a false active run.

- [ ] **Step 2: Replace direct run-store-only status with the aggregate query**

The page may continue using `backlog.start()` for launching, but after start and refresh it must query the aggregate summary. `BacklogRunSummary.status` is not the final business state; display it as process status only.

- [ ] **Step 3: Add explicit join fields to the detail drawer**

Show:

- Backlog ID and provider reference.
- Backlog lifecycle state and execution mode.
- Parent, dependencies, and execution base.
- Active `runId`, runtime phase, heartbeat, branch, worktree, and diagnostics when present.
- A clear empty state when no run exists.

- [ ] **Step 4: Run Desktop renderer tests**

```bash
pnpm --dir desktop-client exec vitest run tests/backlog-page.test.tsx tests/e2e/backlog-list.spec.ts tests/e2e/backlog-create.spec.ts
```

Expected: the page no longer treats the process launch record as the source of Backlog state.

- [ ] **Step 5: Commit the UI integration**

```bash
git add desktop-client/src/features/backlog desktop-client/tests/backlog-page.test.tsx desktop-client/tests/e2e/backlog-list.spec.ts desktop-client/tests/e2e/backlog-create.spec.ts
git commit -m "feat(desktop): show backlog and runtime states separately"
```

## Task 7: Align lifecycle, skills, and documentation

**Files:**
- Modify: `/Users/shenggangshu/llm/afk/docs/ARCHITECTURE.md`
- Modify: `/Users/shenggangshu/llm/afk/docs/WORKFLOWS.md`
- Modify: `/Users/shenggangshu/llm/afk/CLAUDE.md`
- Modify: `/Users/shenggangshu/llm/afk/docs/OBSERVABILITY-HARNESS.md`
- Modify: `/Users/shenggangshu/llm/afk/skills/afk-to-issues/SKILL.md`
- Modify: `/Users/shenggangshu/llm/afk/skills/afk-implement/SKILL.md`

- [ ] **Step 1: Replace stale Issue-era terminology**

Update examples that still use `stage::ready-for-implement`, `afk-issue-<iid>`, or old Issue-only command aliases. Use:

```text
BacklogItem.id
afk/backlog-<id>
afk run --backlog-id <id>
afk qa --backlog-id <id>
```

- [ ] **Step 2: Document the source-of-truth boundary**

State explicitly:

- Provider Backlog owns business identity and lifecycle.
- Runtime records own execution attempts and diagnostics.
- `backlogId` joins the two.
- `runId` identifies one attempt.
- `parentId`, `dependsOn`, and `baseBacklogId` are not interchangeable.

- [ ] **Step 3: Document Desktop behavior**

Explain that `.afk/backlog-runs.json` is launch metadata, while canonical runtime files/events provide execution status. Document the missing-source behavior and stale-runtime semantics.

- [ ] **Step 4: Run documentation consistency checks**

```bash
rg -n "stage::ready-for-implement|afk-issue-|--issue|afk issue|tracker execution" docs CLAUDE.md skills
```

Expected: no active workflow instructions use the removed terminology; historical observation notes may remain only when clearly marked as historical.

- [ ] **Step 5: Commit documentation changes**

```bash
git add docs/ARCHITECTURE.md docs/WORKFLOWS.md CLAUDE.md docs/OBSERVABILITY-HARNESS.md skills/afk-to-issues/SKILL.md skills/afk-implement/SKILL.md
git commit -m "docs: define backlog as the work-item source of truth"
```

## Task 8: Full verification and rollout gate

**Files:**
- No source changes expected unless verification finds a defect.
- Review: all files listed in the previous tasks.

- [ ] **Step 1: Run focused root tests**

```bash
pnpm exec vitest run \
  src/core/backlog-work-item.test.ts \
  src/core/execution-base-policy.test.ts \
  src/application/runtime/task-runtime.test.ts \
  src/lib/runtime/task-runtime.test.ts \
  src/views/board/data/work-item-projection.test.ts \
  src/cli/command-registry.test.ts \
  src/cli/commands/backlog.test.ts \
  src/cli/commands/loop.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Desktop typecheck/build/test gates**

```bash
pnpm --dir desktop-client typecheck
pnpm --dir desktop-client test
pnpm --dir desktop-client build
```

Expected: all three commands pass independently. Build output under `dist/`, `dist-electron/`, and `release/` must not be added to source control.

- [ ] **Step 3: Run root typecheck/build**

```bash
pnpm typecheck
pnpm build
```

Expected: the built `dist/index.js` and source dispatcher expose identical command help.

- [ ] **Step 4: Run the full test suite**

```bash
pnpm test
```

Expected: all new linkage tests pass. Existing unrelated environmental failures must be recorded separately and not masked.

- [ ] **Step 5: Run the CLI/desktop smoke path**

```bash
node dist/index.js backlog --help
node dist/index.js backlog create --help
node dist/index.js backlog list --help
node dist/index.js run --help
node dist/index.js qa --help
node dist/index.js observe --help
```

Expected: all commands load from the same registry, JSON options are documented, and `--backlog-id` remains the stable execution flag.

- [ ] **Step 6: Verify the repository state**

```bash
git status --short
git diff --check
rg -n "BacklogItem|backlogId|workItemId|runId" src desktop-client/shared desktop-client/electron desktop-client/src | sed -n '1,240p'
```

Expected: no generated build output is staged, no whitespace errors exist, and every cross-layer runtime record has an explicit `backlogId` path.

- [ ] **Step 7: Write the rollout note**

Record the following acceptance results in the change summary:

1. A Provider Backlog item can be listed, shown, created, and started through the same CLI that Desktop invokes.
2. A run started with `--backlog-id X` writes `workItemId: X` and `runtime.backlogId: X`.
3. TUI and Desktop can show a Backlog with no runtime, an active runtime, a stale runtime, and a completed runtime.
4. Backlog lifecycle state and runtime execution state are displayed separately.
5. The pure core model preserves parent, dependency, and execution-base semantics.
6. No renderer code performs local I/O or imports Node/Electron.

## Risks and rollback points

- **CLI migration risk:** Keep the old command modules until the new public registry passes source, build, and Desktop smoke tests. Roll back only the dispatcher wiring if the new path breaks unrelated commands.
- **State mapping risk:** Do not silently collapse `rework`, `blocked`, or `merge_ready` into generic runtime phases. The projection tests must preserve both Backlog state and runtime phase.
- **Runtime freshness risk:** A stale heartbeat is not equivalent to a failed Backlog. Display `stale` as a runtime diagnostic while leaving Provider Backlog state unchanged.
- **Desktop process-store risk:** `.afk/backlog-runs.json` can only describe process launch/exit. It must not be used to infer `done`, `verification`, or `blocked` business state.
- **Generated-file risk:** Do not commit `dist/`, `dist-electron/`, `release/`, or screenshots.
- **Untracked baseline:** `/Users/shenggangshu/llm/afk/desktop-client/.dev/` was already untracked before this plan and must remain untouched unless explicitly requested.

## Completion criteria

The implementation is complete only when all of the following are true:

- One public CLI registry serves source, build, and Desktop consumers.
- `BacklogItem.id` is the only business work-item identity across layers.
- Every execution record has both `runId` and `backlogId`.
- `core.WorkItem` is an explicit projection, not an unconnected second source of truth.
- TUI and Desktop show Backlog lifecycle state and runtime execution state independently.
- Provider labels remain confined to provider adapters.
- Focused tests, Desktop typecheck/build/test, root typecheck/build, and full tests have been run and their results recorded.
