# TUI Backlog Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the TUI to use the claim-free backlog management backend while preserving read-only navigation, runtime session visibility, and browser links.

**Architecture:** `DashboardEntry` will construct and inject `ManagementProviderBundle` into a TUI data adapter. Backlog records will be mapped to a provider-neutral `BacklogViewModel`; Ink views will render canonical state/mode/parent/dependency fields, while tmux sessions remain a separate runtime read model. Browser navigation will use provider-supplied URLs through `openInBrowser`.

**Tech Stack:** TypeScript, React, Ink, Vitest, existing `ManagementProviderBundle`, `BacklogItem`, and `openInBrowser` utility.

---

### Task 1: Extend the backlog model and create the TUI backlog adapter

**Files:**
- Modify: `src/lib/core/backlog/index.ts`
- Modify: `src/lib/core/backlog/tracker-adapter.ts`
- Create: `src/views/board/data/backlog-adapter.ts`
- Test: `src/views/board/data/backlog-adapter.test.ts`

- [ ] **Step 1: Write failing model and mapping tests**

```ts
it('maps canonical backlog fields without reading provider labels', () => {
  const item: BacklogItem = {
    id: '42', title: 'Fix API', description: 'desc', parentId: '10',
    dependsOn: ['9'], state: 'verification', executionMode: 'afk',
    tags: ['team:api'], branchName: 'afk/backlog-42',
    providerRef: 'github:org/repo#42', webUrl: 'https://github.com/org/repo/issues/42',
  };
  expect(toBacklogViewModel(item)).toMatchObject({
    id: '42', state: 'verification', executionMode: 'afk',
    parentId: '10', dependsOn: ['9'], webUrl: item.webUrl,
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run src/views/board/data/backlog-adapter.test.ts`

Expected: failure because `webUrl` and `toBacklogViewModel` do not exist.

- [ ] **Step 3: Add `webUrl?: string` to `BacklogItem` and populate tracker providers**

Set `webUrl: issue.url` in `toBacklogItem`. Keep it optional so plugin providers
without a browser URL remain valid.

- [ ] **Step 4: Implement the adapter**

Create `BacklogViewModel` with `id`, `title`, `description`, `state`,
`executionMode`, `parentId`, `dependsOn`, `tags`, `branchName`, `providerRef`,
and `webUrl`. Implement pure `toBacklogViewModel(item)` and a loader that calls
only `ManagementProviderBundle.backlog.list()`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm exec vitest run src/views/board/data/backlog-adapter.test.ts && pnpm typecheck`

Expected: pass.

---

### Task 2: Inject the management backend into the dashboard data flow

**Files:**
- Modify: `src/views/app/DashboardEntry.tsx`
- Modify: `src/views/board/data/useData.ts`
- Modify: `src/views/board/data/fetcher.ts`
- Modify: `src/views/board/cache.ts`
- Test: `src/views/board/data/useData.test.ts`

- [ ] **Step 1: Write failing provider-injection tests**

```ts
it('loads backlog records through the claim-free management provider', async () => {
  const claim = vi.fn();
  const item: BacklogItem = {
    id: '42', title: 'Fix API', dependsOn: [], state: 'ready', executionMode: 'afk',
    tags: [], branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42',
  };
  const provider = { list: vi.fn(async () => [item]), get: vi.fn(), claim };
  const models = await loadBacklogViewModels({ backlog: provider } as never);
  expect(models[0].id).toBe(item.id);
  expect(claim).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run src/views/board/data/useData.test.ts`

Expected: failure because the dashboard still loads `fetchIssues()` through a
tracker client.

- [ ] **Step 3: Inject `ManagementProviderBundle`**

Construct the management bundle once in `DashboardEntry` and pass it into
`useData`. Do not instantiate `TrackerProvider` inside TUI fetchers.

- [ ] **Step 4: Replace issue loading with backlog loading**

Use `backlog.list(options)` and adapter mapping. Keep `fetchTasks()` and
`fetchSessions()` read-only runtime data. Remove TUI calls to
`createTaskFromIssue`, `launchTask`, and `killSession` from the backlog screen.

- [ ] **Step 5: Preserve read-only cache behavior**

Cache view models only for display. Refresh replaces cached values from the
provider and never writes backlog state.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm exec vitest run src/views/board/data/useData.test.ts && pnpm typecheck`

Expected: pass.

---

### Task 3: Update Ink views to canonical backlog fields and browser navigation

**Files:**
- Modify: `src/types/board.ts`
- Modify: `src/views/board/board/BoardView.tsx`
- Modify: `src/views/board/views/IssueListView.tsx`
- Modify: `src/views/board/views/PreviewPanel.tsx`
- Modify: `src/views/app/AppContent.tsx`
- Modify: `src/views/app/actions/handlers.ts`
- Modify: `src/views/board/views/DetailScreen.tsx`
- Test: `src/views/board/board/BoardView.test.tsx`
- Test: `src/views/app/actions/handlers.test.ts`

- [ ] **Step 1: Write failing rendering and navigation tests**

```ts
it('renders verification and hitl from canonical fields', () => {
  const item: BacklogViewModel = {
    id: '42', title: 'Fix API', description: '', state: 'verification',
    executionMode: 'hitl', parentId: undefined, dependsOn: [], tags: [],
    branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42',
  };
  const output = render(<BoardView items={[item]} selectedIndex={0} scrollOffset={0} viewportHeight={10} />);
  expect(output.lastFrame()).toContain('verification');
});

it('opens only the provider-supplied URL', async () => {
  const open = vi.fn(async () => {});
  await openBacklogUrl({ id: '42', webUrl: 'https://example/42' }, open);
  expect(open).toHaveBeenCalledWith('https://example/42', 'backlog 42');
});
```

- [ ] **Step 2: Replace `Issue` label logic**

Render colors and labels from `BacklogState` and `BacklogExecutionMode`.
Display parent and dependencies in the detail panel. Never inspect a provider
label string.

- [ ] **Step 3: Remove write actions from the TUI**

Remove or disable task creation, launch, session kill, tag mutation, claim,
transition, and merge handlers. Keep selection, search, refresh, detail view,
session inspection, and browser navigation.

- [ ] **Step 4: Centralize browser opening**

Route backlog/change/project/branch links through `openInBrowser(url, label)`.
When the URL is absent, show a notification and do not reconstruct one from an
ID or provider-specific format.

- [ ] **Step 5: Run focused UI tests**

Run: `pnpm exec vitest run src/views/board/board/BoardView.test.tsx src/views/app/actions/handlers.test.ts`

Expected: pass.

---

### Task 4: Remove legacy TUI data dependencies and verify the integration

**Files:**
- Modify: `src/views/app/AppContent.tsx`
- Modify: `src/views/app/DashboardEntry.tsx`
- Modify: `src/views/board/data/fetcher.ts`
- Modify: `src/views/board/data/useData.ts`
- Modify: `src/views/board/views/index.ts`
- Test: `src/commands/board.test.ts`
- Test: `src/views/board/integration.test.tsx`

- [ ] **Step 1: Add an integration test with a fake management provider**

Assert that a fake provider item appears with canonical state/mode/relationship
data and that its `claim` spy is never called.

- [ ] **Step 2: Remove tracker/label imports from TUI backlog code**

After the integration test passes, `rg` over `src/views` must show no imports of
`TrackerProvider`, `TrackedIssue`, `fetchIssues`, or reads of `stage::`/`mode::`.

- [ ] **Step 3: Verify browser navigation and read-only behavior**

Run the navigation tests and assert no `launch`, `kill`, `transition`, `tag`,
or `claim` provider method is called during render or selection.

- [ ] **Step 4: Run full verification**

```bash
pnpm typecheck
pnpm build
pnpm exec vitest run
git diff --check
```

Expected: all commands exit 0; TUI code has no legacy tracker/label data path.
