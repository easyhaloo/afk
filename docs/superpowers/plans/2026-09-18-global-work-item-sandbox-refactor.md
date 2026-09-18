# Global Work-Item Inventory and Isolated Execution Refactor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make work items a provider-global inventory across every repository the user can access, remove local-directory requirements from discovery, and execute each selected item in an isolated `.loop-workspace/<taskId>/` directory.

**Architecture:** Split the current workspace-coupled backlog path into two independent contexts. A provider inventory service discovers accessible repositories and their issues; an execution workspace service allocates and owns one isolated directory per work item. The renderer consumes a provider-neutral global work-item model and only requests an execution workspace when the user starts a run.

**Tech Stack:** TypeScript, Electron IPC, React, GitHub REST/Octokit, GitLab API, `simple-git`, Vitest, Playwright/Electron E2E.

---

## Non-negotiable invariants

- Work-item discovery never receives or infers a local filesystem workspace.
- Discovery scope is the authenticated user's accessible GitHub repositories and GitLab projects.
- Every provider project is paginated; every project's issue list is paginated; partial failures are visible and do not erase successful results.
- Work-item identity is globally unique and stable: `platform:projectKey#issueNumber`.
- `runId` identifies an execution attempt; it is never the business work-item identity.
- Execution creates or reuses `.loop-workspace/<taskId>/`; it never executes in the user's selected source directory.
- A task directory contains a checkout/worktree, runtime state, logs, diagnostics, and cleanup metadata.
- Read-only discovery can work without any local Git checkout.
- Starting a task requires an execution workspace policy, but the UI may create the default one automatically.
- Provider state and local runtime state remain separate and are projected together only at the UI boundary.
- Missing credentials, inaccessible projects, empty results, stale runtime, and execution failures are distinct diagnostics.
- All accessible issues may be visible, but only AFK-managed issues are executable; an unlabelled issue must never silently become a runnable `ready` task.

## Current coupling to remove

- `desktop-client/src/features/backlog/BacklogPage.tsx:135-168` passes `workspace` into list/show/control operations.
- `desktop-client/electron/services/backlog-service.ts:95-103` uses the workspace as CLI `cwd` for read operations.
- `src/application/tracker-provider-factory.ts:68-80` detects a single tracker project from a local Git remote.
- `desktop-client/electron/services/workspace-service.ts:6-10` falls back from an absent workspace to the process directory's parent, which can become `/` in a packaged app.
- `desktop-client/src/main.tsx:230-238` labels the local runtime queue as `工作项`, while provider Backlog is a separate navigation entry.
- `desktop-client/electron/services/backlog-execution-service.ts:11-18` stores and resolves runs by a caller-provided workspace.

## Target architecture

```text
Provider credentials
        |
        v
Provider catalog --------------------+
  accessible projects                |
  paginated issues                   v
        |                    Global work-item inventory
        |                    (provider-neutral DTOs)
        |                              |
        |                              v
        |                    Renderer work-item list/detail
        |
        +--> Selected work item --> Execution workspace allocator
                                      |
                                      v
                            .loop-workspace/<taskId>/
                                      |
                                      v
                          afk loop / agent / QA / runtime
                                      |
                                      v
                         runtime projection + provider transition
```

## Target data model

Add provider-neutral identity and project fields. Do not overload a local path as project identity.

```ts
type WorkItemId = string; // `${platform}:${projectKey}#${issueNumber}`

type ProviderProjectRef = {
  platform: "github" | "gitlab";
  projectKey: string;       // owner/repo or host/group/project path
  providerProjectId?: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
};

type GlobalWorkItem = {
  id: WorkItemId;
  issueNumber: number;
  project: ProviderProjectRef;
  title: string;
  description?: string;
  managed: boolean;
  executionEligible: boolean;
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  parentId?: WorkItemId;
  dependsOn: WorkItemId[];
  tags: string[];
  branchName: string;
  providerRef: string;
  webUrl?: string;
};

type ExecutionWorkspace = {
  taskId: WorkItemId;
  root: string;
  checkout: string;
  runtime: string;
  logs: string;
  diagnostics: string;
  createdAt: string;
  sourceProject: ProviderProjectRef;
};
```

For issues without AFK workflow metadata, retain the provider issue in the inventory with `managed: false` and `executionEligible: false`. The UI may show an `未纳入 AFK` state and offer an explicit “纳入工作流” action later; it must not infer that a generic provider issue is ready to execute.

The existing `BacklogItem.id` may remain as a compatibility field during migration, but all new desktop APIs, cache keys, runtime records, and workspace paths must use `WorkItemId`. Normalize old values such as `142` only when the provider/project context is known; never guess a global ID from a bare number.

## Target IPC contracts

Replace workspace-bound list APIs with provider-inventory APIs:

```ts
backlog.inventory(options?: BacklogInventoryOptions): Promise<BacklogInventoryResult>;
backlog.show(workItemId: string): Promise<GlobalWorkItem>;
backlog.start(input: BacklogRunStartInput): Promise<BacklogRunSummary>;
backlog.runtime(workItemId: string): Promise<BacklogRuntimeSummary | null>;
backlog.refresh(): Promise<BacklogInventoryResult>;
```

`BacklogInventoryResult` must contain:

```ts
type BacklogInventoryResult = {
  items: GlobalWorkItem[];
  projects: ProviderProjectRef[];
  diagnostics: InventoryDiagnostic[];
  fetchedAt: string;
  complete: boolean;
};
```

`InventoryDiagnostic` must include platform, project when known, code (`auth`, `rate_limit`, `not_found`, `provider`, `partial`, `unknown`), message, and retryability. A single inaccessible project must not make all accessible work items disappear.

## Target execution workspace

Create a dedicated main-process service:

```ts
createExecutionWorkspaceService({
  baseDirectory: resolveDefaultLoopWorkspace(),
  mkdir,
  git,
  now,
});
```

Default root:

```text
~/.loop-workspace/
```

Per-task directory:

```text
~/.loop-workspace/<encoded-task-id>/
  checkout/
  runtime/
  logs/
  diagnostics/
  workspace.json
```

`workspace.json` records the canonical task ID, provider project, source URL, branch, checkout path, creation time, current run ID, and cleanup status. Use a filesystem-safe encoding of the global ID; do not use raw `/`, `:`, or `#` in path segments.

Retries reuse the same task directory and create a new `runId` record under `runtime/attempts/<runId>/`. Concurrent starts for the same task are rejected by a task lock. Different tasks may run concurrently in separate directories.

---

## Implementation plan

### Task 1: Define global identity and provider project primitives

**Files:**
- Create: `src/domain/work-item/identity.ts`
- Create: `src/domain/work-item/types.ts`
- Create: `src/domain/work-item/identity.test.ts`
- Modify: `src/domain/backlog/index.ts`
- Modify: `desktop-client/shared/backlog-contract.ts`

- [ ] Add `WorkItemId`, `ProviderProjectRef`, `GlobalWorkItem`, and parsing/formatting helpers.
- [ ] Ensure parsing rejects malformed IDs, empty project keys, unsupported platforms, and non-positive issue numbers.
- [ ] Add tests for GitHub owner/repo IDs, GitLab host/group/project IDs, path-safe directory encoding, and collisions between two repositories with the same issue number.
- [ ] Extend the shared DTO parser to validate project and global identity fields.
- [ ] Keep existing fields temporarily so old CLI consumers continue to compile.

### Task 2: Add credential-scoped provider catalog interfaces

**Files:**
- Create: `src/domain/tracker/catalog.ts`
- Create: `src/domain/tracker/catalog.test.ts`
- Modify: `src/domain/tracker/types.ts`
- Modify: `src/infrastructure/github/client.ts`
- Modify: `src/infrastructure/gitlab/index.ts`
- Modify: `src/application/tracker-provider-factory.ts`

- [ ] Define a catalog interface that can list all accessible projects without a `cwd`.
- [ ] Add GitHub repository discovery using the authenticated user's accessible repositories, with page/per-page cursors and repository metadata.
- [ ] Add GitLab project discovery using membership-visible projects, with page/per-page cursors and host metadata.
- [ ] Add a factory that resolves credentials only; it must not require a repository or local directory.
- [ ] Keep the existing single-project tracker factory for CLI commands that intentionally operate on one project.
- [ ] Add tests proving catalog construction succeeds without a Git remote and that project identity is stable.

### Task 3: Implement paginated global inventory

**Files:**
- Create: `src/application/work-items/inventory-service.ts`
- Create: `src/application/work-items/inventory-service.test.ts`
- Create: `src/application/work-items/project-issue-adapter.ts`
- Create: `src/application/work-items/project-issue-adapter.test.ts`
- Modify: `src/domain/backlog/tracker-adapter.ts`
- Modify: `src/lib/core/backlog/tracker-adapter.ts`

- [ ] For each accessible project, create a project-scoped tracker and fetch all issues with pagination.
- [ ] Convert each issue to `GlobalWorkItem` using the project reference and issue number.
- [ ] Preserve AFK metadata labels and business tags while hiding provider workflow labels from the renderer.
- [ ] Resolve parent/dependency references to global IDs; emit diagnostics when a referenced item is missing or belongs to an inaccessible project.
- [ ] Deduplicate by global ID, not title or bare issue number.
- [ ] Bound concurrency to a configurable value and preserve deterministic output ordering by platform/project/issue number.
- [ ] Return successful items plus project-level diagnostics when one project fails.
- [ ] Add tests for pagination, partial failure, duplicate issue numbers across projects, inaccessible dependencies, and deterministic ordering.

### Task 4: Add an explicit CLI inventory command

**Files:**
- Modify: `src/cli/commands/backlog.ts`
- Create: `src/cli/commands/backlog-inventory.test.ts`
- Modify: `src/cli/command-registry.test.ts`
- Modify: `docs/WORKFLOWS_zh.md`

- [ ] Add `afk backlog inventory --json` as the desktop-facing command.
- [ ] Support `--platform github|gitlab|all`, state/mode/tag filters, and an optional project filter.
- [ ] Preserve `afk backlog list` as a compatibility command for one explicitly selected project until migration completes.
- [ ] Emit a stable JSON envelope with `kind: "backlog.inventory"`, items, projects, diagnostics, and `complete`.
- [ ] Ensure the command never uses `process.cwd()` to determine discovery scope.
- [ ] Add CLI tests for success, all-project partial failure, auth failure, and empty accessible inventory.

### Task 5: Replace the Electron read path with inventory service

**Files:**
- Create: `desktop-client/electron/services/work-item-inventory-service.ts`
- Create: `desktop-client/electron/services/work-item-inventory-service.test.ts`
- Modify: `desktop-client/electron/services/backlog-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/shared/backlog-contract.ts`

- [ ] Add an Electron service that invokes `afk backlog inventory --json` without a workspace `cwd`; use a controlled process cwd only for subprocess stability, never for repository selection.
- [ ] Parse and validate the inventory envelope at the IPC boundary.
- [ ] Cache inventory by provider scope and filter set, not by workspace path.
- [ ] Cache successful project results separately so a transient failure in one project does not discard prior good data.
- [ ] Expose diagnostics and retryability to the renderer.
- [ ] Add tests for command construction, envelope validation, cache invalidation, partial results, timeout, and malformed output.

### Task 6: Refactor execution workspace allocation

**Files:**
- Create: `desktop-client/electron/services/execution-workspace-service.ts`
- Create: `desktop-client/electron/services/execution-workspace-service.test.ts`
- Modify: `desktop-client/electron/services/backlog-execution-service.ts`
- Modify: `desktop-client/electron/services/backlog-run-store.ts`
- Modify: `desktop-client/electron/services/backlog-runtime-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/shared/backlog-contract.ts`

- [ ] Add a default base-directory resolver for `~/.loop-workspace` with an explicit user override in settings.
- [ ] Create a task directory atomically using the encoded global task ID.
- [ ] Persist `workspace.json` before starting a child process.
- [ ] Clone/fetch the provider project into `checkout/`, then create the task branch/worktree inside the task directory.
- [ ] Pass the task directory and provider project explicitly to the CLI; do not depend on the user's source directory or Git remote detection.
- [ ] Move run store keys from `workspace/backlogId` to `taskId`, with migration support for old records.
- [ ] Ensure cleanup never deletes a directory outside the configured `.loop-workspace` root.
- [ ] Add tests for path safety, concurrent allocation, retry reuse, stale task recovery, failed clone cleanup, and cross-task isolation.

### Task 7: Update the CLI execution entry point

**Files:**
- Modify: `src/application/tracker-provider-factory.ts`
- Modify: `src/application/workflows/run-cmd.ts`
- Modify: `src/cli/commands/loop.ts`
- Create: `src/application/work-items/execution-context.ts`
- Create: `src/application/work-items/execution-context.test.ts`
- Modify: `src/domain/backlog/commands.ts`
- Modify: `src/domain/backlog/tracker-adapter.ts`

- [ ] Accept an explicit `--provider`, `--project`, `--work-item-id`, and `--execution-root` context for task execution.
- [ ] Resolve the provider project from the canonical work-item ID, not from the execution directory's Git remote.
- [ ] Keep provider transitions scoped to the work item's project.
- [ ] Validate that the checked-out repository matches the provider project before agents run.
- [ ] Preserve existing `--backlog-id` behavior only as a compatibility adapter when a project can be resolved unambiguously.
- [ ] Add tests for explicit context, mismatched checkout, invalid global ID, and compatibility mode.

### Task 8: Redesign renderer state and navigation

**Files:**
- Create: `desktop-client/src/features/work-items/WorkItemsPage.tsx`
- Create: `desktop-client/src/features/work-items/work-item-filter.ts`
- Create: `desktop-client/src/features/work-items/work-item-view-model.ts`
- Create: `desktop-client/src/features/work-items/WorkItemsPage.test.tsx`
- Modify: `desktop-client/src/main.tsx`
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `desktop-client/src/features/backlog/backlog-cache.ts`
- Modify: `desktop-client/src/features/backlog/backlog.css`

- [ ] Rename the provider-facing navigation entry to `工作项` and make it the default landing view after inventory initialization.
- [ ] Rename the local runtime entry to `运行队列`; keep `运行看板` and `运行记录` under the execution section.
- [ ] Add project/platform filters and show project identity on every row.
- [ ] Render separate states for loading, empty inventory, partial inventory, authentication failure, and provider failure.
- [ ] Show runtime projection on each work-item row without making runtime data required for discovery.
- [ ] Disable only execution actions when the task is not runnable; do not hide the work item.
- [ ] Add a detail drawer with provider metadata, dependencies, current runtime, execution directory, and next action.
- [ ] Remove `workspace` from read-only list/show props.
- [ ] Add tests for global ID rendering, same-number issues in different projects, partial diagnostics, state filtering, and action availability.

### Task 9: Add execution status and lifecycle integration

**Files:**
- Modify: `desktop-client/electron/services/backlog-runtime-service.ts`
- Modify: `desktop-client/electron/services/backlog-execution-service.ts`
- Modify: `desktop-client/src/features/work-items/WorkItemsPage.tsx`
- Create: `desktop-client/src/features/work-items/runtime-projection.ts`
- Create: `desktop-client/src/features/work-items/runtime-projection.test.ts`
- Modify: `src/shared/goal-complete.ts`
- Modify: `docs/WORKFLOWS_zh.md`

- [ ] Join provider work items to runtime records by `WorkItemId`.
- [ ] Display lifecycle transitions as provider state plus local execution phase.
- [ ] On start, show allocation, checkout, running, verifying, and provider-transition progress.
- [ ] On stale/failed runs, expose recover, retry, inspect diagnostics, and open task directory actions.
- [ ] Ensure a completed local run does not imply provider `done` until the provider transition succeeds.
- [ ] Add tests for missing runtime, stale runtime, retry attempts, provider transition failure, and completed provider state.

### Task 10: Migrate storage, configuration, and compatibility

**Files:**
- Create: `desktop-client/electron/services/work-item-state-migration.ts`
- Create: `desktop-client/electron/services/work-item-state-migration.test.ts`
- Modify: `desktop-client/electron/services/workspace-preference-service.ts`
- Modify: `desktop-client/electron/services/desktop-service.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/main.ts`
- Modify: `docs/DESKTOP-DESIGN-STANDARDS.md`

- [ ] Store provider scope and `.loop-workspace` base directory separately from any legacy workspace preference.
- [ ] Migrate old `backlog-runs.json` records using `providerRef` when possible; mark ambiguous records as unresolved instead of guessing.
- [ ] Preserve old workspace preference only for importing existing local runs, not for provider discovery.
- [ ] Add settings for provider refresh, enabled platforms, concurrency, and execution root.
- [ ] Add a first-run health check that reports CLI version, credential status, provider count, inventory count, and execution-root writability.
- [ ] Update design guidance so empty states and setup states are visually and semantically distinct.

### Task 11: End-to-end verification and packaging

**Files:**
- Create: `desktop-client/tests/e2e/work-items-global.spec.ts`
- Create: `desktop-client/tests/e2e/work-item-execution-isolation.spec.ts`
- Modify: `desktop-client/tests/e2e/_helpers/launch.ts`
- Modify: `desktop-client/playwright.config.ts`
- Modify: `desktop-client/package.json`
- Modify: `.github/workflows/*` relevant desktop workflow

- [ ] Add a fake inventory CLI that returns issues from at least two repositories with the same issue number.
- [ ] Verify the app shows both items without selecting a source directory.
- [ ] Start both items and verify their task directories are distinct under `.loop-workspace`.
- [ ] Verify a retry reuses the task directory while creating a new run attempt.
- [ ] Verify one project failure leaves successful project items visible with a diagnostic banner.
- [ ] Verify a missing workspace preference does not resolve to `/`.
- [ ] Verify packaged app startup uses the same renderer and main-process contract as development mode.
- [ ] Run independent desktop typecheck, build, unit tests, and E2E tests in CI.

---

## Rollout sequence

1. Ship global identity and catalog primitives behind tests.
2. Ship `backlog inventory --json` while keeping current-project `backlog list` unchanged.
3. Ship Electron inventory IPC and renderer read-only page; do not change execution yet.
4. Ship execution workspace allocation behind a feature flag and run isolation E2E.
5. Switch start/retry/recover/stop/merge controls to task ID and explicit provider project.
6. Migrate old run records and remove workspace-bound backlog APIs after one compatibility release.
7. Remove local-directory detection from provider discovery and delete the `/` fallback.
8. Rebuild and smoke-test the packaged app before release; never rely on an older `release/` artifact.

## Acceptance criteria

- Opening the app with no local directory selected shows all accessible work items or an explicit provider-auth diagnostic.
- Two accessible repositories containing `#1` produce two distinct rows and IDs.
- A repository that cannot be queried does not erase items from other repositories.
- Selecting a work item creates `.loop-workspace/<taskId>/` automatically.
- No agent process spawned by the desktop flow has the user's source directory as its execution cwd.
- Two simultaneous tasks never share checkout, runtime, logs, or diagnostics.
- Retry creates a new run attempt without losing prior diagnostics.
- Work-item list, detail, runtime status, and provider transitions all use the same canonical global task ID.
- An absent workspace preference never resolves to `/`.
- Development and packaged builds pass the same inventory and isolation smoke test.

## Verification commands

```bash
pnpm exec vitest run \
  src/domain/work-item/identity.test.ts \
  src/domain/tracker/catalog.test.ts \
  src/application/work-items/inventory-service.test.ts \
  desktop-client/electron/services/execution-workspace-service.test.ts \
  desktop-client/src/features/work-items/WorkItemsPage.test.tsx

pnpm --dir desktop-client typecheck
pnpm --dir desktop-client build
pnpm --dir desktop-client test
pnpm --dir desktop-client e2e --project=electron
```

Do not run broad verification until the implementation work is ready; the repository currently contains unrelated uncommitted changes in desktop SSH and canvas files.
