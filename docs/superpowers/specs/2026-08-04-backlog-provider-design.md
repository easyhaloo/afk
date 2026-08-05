# Backlog Provider Runtime Design

## Goal

Make AFK execute externally-created backlog items through a platform-neutral contract. AFK claims and executes one ready item at a time; it does not split a parent backlog or invent child work.

## Core model

```ts
type BacklogState = 'ready' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';
type ExecutionMode = 'afk' | 'hitl';

interface BacklogItem {
  id: string;
  title: string;
  description?: string;
  parentId?: string;
  dependsOn: string[];
  state: BacklogState;
  executionMode: ExecutionMode;
  branchName: string;
  providerRef: string;
}
```

`parentId` identifies an external grouping backlog and is never executed directly. `dependsOn` contains backlog IDs that must be `done` before the item is runnable. A backlog is runnable only when it is `ready`, has `executionMode: afk`, has no unresolved dependencies, and is not a parent with children. AFK derives a stable branch from the backlog ID (`afk/backlog-<id>` unless the provider supplies an explicit branch).

## Provider boundaries

`BacklogProvider` owns retrieval, dependency checks, atomic claim, canonical state transitions, execution mode, and provider metadata. `BranchProvider` owns branch/worktree/commit/push operations. `ChangeProvider` owns change request creation, lookup, merge, and close. `WorkflowRunner` directly orchestrates these three contracts and agent/sandbox services. No runner code reads GitHub/GitLab labels or calls their SDKs.

```ts
interface BacklogProvider {
  get(id: string): Promise<BacklogItem>;
  list(options?: { state?: BacklogState; executionMode?: ExecutionMode; parentId?: string }): Promise<BacklogItem[]>;
  claim(id: string, owner: string): Promise<BacklogItem | null>; // atomic ready -> in_progress
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void>;
  setExecutionMode(id: string, mode: ExecutionMode): Promise<void>;
  isRunnable(item: BacklogItem): Promise<boolean>;
}

interface BranchProvider {
  createBranch(item: BacklogItem, baseBranch: string): Promise<{ branchName: string; worktreePath: string }>;
  push(branchName: string, worktreePath: string): Promise<void>;
  commit(worktreePath: string, message: string): Promise<string>;
  cleanup(worktreePath: string, options?: { preserve?: boolean }): Promise<void>;
}

interface ChangeProvider {
  create(input: { backlog: BacklogItem; sourceBranch: string; targetBranch: string; draft?: boolean }): Promise<{ id: string; url?: string }>;
  get(id: string): Promise<{ id: string; state: 'open' | 'merged' | 'closed'; sourceBranch: string; targetBranch: string; url?: string }>;
  merge(id: string): Promise<void>;
  close(id: string, reason?: string): Promise<void>;
}
```

## Platform adapters

The GitHub and GitLab adapters implement `BacklogProvider` by mapping issue fields and labels to canonical state/mode. The mapping is one-way at the boundary: labels such as `stage::ready-for-issues`, `stage::afk-in-progress`, `stage::qa`, `stage::done`, `mode::afk`, and `mode::hitl` never appear in runner logic. `claim()` must use the provider's conditional update/compare-and-set operation and return `null` when another worker won the race. A non-atomic adapter is rejected during construction.

Existing `TrackerProvider` remains available for legacy commands and is wrapped by an adapter during migration. Change and branch operations are extracted from it without introducing `BacklogExecutionService`.

## Execution and failure lifecycle

```text
BacklogProvider.claim
  -> BranchProvider.createBranch
  -> WorkflowRunner agent execution
  -> BranchProvider.push
  -> ChangeProvider.create
  -> verification
  -> ChangeProvider.merge
  -> BacklogProvider.transition(done)
```

Dependency or parent violations leave the item `ready` and return a skip result. Agent failure, timeout, handoff exhaustion, branch conflict, push failure, change creation failure, or verification failure transition the item to `blocked` and set execution mode to `hitl`. State transitions are idempotent and include a reason. A successful run transitions through `verification` and `merge_ready` before `done`; only an explicit verification PASS may call `ChangeProvider.merge`.

## Compatibility and migration

1. Add canonical types and adapters while retaining `TrackerProvider` exports.
2. Update `client-factory` to construct a provider bundle (`backlog`, `branch`, `change`) for new workflow paths.
3. Make `WorkflowRunner` accept the bundle while preserving the current tracker constructor overload for legacy tests/commands.
4. Migrate loop and QA selection to `BacklogProvider`; keep legacy tracker commands unchanged.
5. Deprecate direct tracker access in workflow code after adapter coverage is complete.

## Testing

Tests cover canonical label mapping, atomic claim races, parent/dependency runnable checks, branch derivation, idempotent transitions, provider bundle construction, runner orchestration, and all blocked outcomes. Existing workflow and CLI compatibility tests remain required.
