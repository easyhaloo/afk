# External TUI Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore trusted, user-installed TUI plugin pages from `~/.afk/plugins` without reintroducing the unused generic TUI Core.

**Architecture:** Add a small loader/normalizer under `src/views/plugins/` that reads the existing YAML config, dynamically imports enabled plugin entry points, validates them, and returns host-owned descriptors. Extend the current view ID and navigation flow to accept namespaced plugin views while keeping all built-in data and rendering branches explicit. Render plugin pages through an error-isolated boundary with a deliberately narrow context.

**Tech Stack:** TypeScript, React, Ink, Vitest, `js-yaml`, Node ESM dynamic imports.

---

## File Map

- Create `src/views/plugins/types.ts` for the plugin contract and normalized host descriptors.
- Create `src/views/plugins/loader.ts` for YAML discovery, dynamic imports, validation, and normalization.
- Create `src/views/plugins/loader.test.ts` for loader behavior and failure isolation.
- Create `src/views/plugins/PluginViewBoundary.tsx` for plugin rendering and render-error containment.
- Create `src/views/plugins/PluginViewBoundary.test.tsx` for successful and failing plugin renders.
- Modify `src/views/board/types.ts` to distinguish built-in IDs from namespaced plugin IDs.
- Modify `src/views/app/state/initialState.ts` and `src/views/app/state/StateContext.tsx` so navigation actions can carry a host-owned plugin view ID without allowing arbitrary IDs into built-in action targets.
- Modify `src/views/app/AppContent.tsx` to render plugin pages separately from `Body` and to pass the narrow context.
- Modify `src/views/app/DashboardEntry.tsx` to load plugins once before rendering the interactive dashboard.
- Modify `src/views/board/views/Header.tsx` to display accepted plugin shortcuts and titles.
- Modify `src/views/board/views/Footer.tsx` and `src/views/board/views/HelpDialog.tsx` to include plugin shortcut hints without changing built-in hints.
- Modify `CLAUDE.md`, `docs/TESTING.md`, and `docs/TESTING_zh.md` to document the new plugin API and remove deleted TUI Core references.

## Task 1: Define the Minimal Plugin Contract

**Files:**
- Create: `src/views/plugins/types.ts`
- Modify: `src/views/board/types.ts:1-23`
- Test: `src/views/plugins/loader.test.ts`

- [ ] **Step 1: Add failing type-level/runtime shape tests**

Create test fixtures that represent the only accepted plugin shape:

```ts
const validPlugin = {
  id: 'example',
  name: 'Example',
  views: [{ id: 'status', title: 'Status', shortcut: 'z', render: () => null }],
};

expect(isTuiPlugin(validPlugin)).toBe(true);
expect(isTuiPlugin({ id: 'example', name: 'Example', views: [] })).toBe(true);
expect(isTuiPlugin({ id: '', name: 'Example', views: [] })).toBe(false);
expect(isTuiPlugin({ id: 'example', name: 'Example', views: [{ id: 'status' }] })).toBe(false);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run src/views/plugins/loader.test.ts`

Expected: FAIL because `isTuiPlugin` and the plugin contract do not exist.

- [ ] **Step 3: Implement the host-owned types and validator**

Use a string type for built-in and plugin IDs while retaining explicit built-in
guards:

```ts
import type { ReactNode } from 'react';

export type BuiltinView = 'tasks' | 'backlogs' | 'projects' | 'board';
export type TuiViewId = BuiltinView | `plugin:${string}:${string}`;

export interface TuiPluginContext {
  readonly cwd: string;
  readonly workspace?: string;
  readonly notify: (message: string) => void;
}

export interface TuiPluginView {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
  readonly render: (context: TuiPluginContext) => ReactNode;
}

export interface TuiPlugin {
  readonly id: string;
  readonly name: string;
  readonly views: readonly TuiPluginView[];
}

export interface LoadedTuiView {
  readonly id: TuiViewId;
  readonly pluginId?: string;
  readonly title: string;
  readonly shortcut: string;
  readonly render?: TuiPluginView['render'];
}

export function isTuiPlugin(value: unknown): value is TuiPlugin {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as Partial<TuiPlugin>;
  return typeof plugin.id === 'string'
    && plugin.id.trim().length > 0
    && typeof plugin.name === 'string'
    && plugin.name.trim().length > 0
    && Array.isArray(plugin.views)
    && plugin.views.every(view => {
      if (!view || typeof view !== 'object') return false;
      const candidate = view as Partial<TuiPluginView>;
      return typeof candidate.id === 'string'
        && candidate.id.trim().length > 0
        && typeof candidate.title === 'string'
        && candidate.title.trim().length > 0
        && typeof candidate.shortcut === 'string'
        && candidate.shortcut.trim().length > 0
        && typeof candidate.render === 'function';
    });
}
```

Update `src/views/board/types.ts` to re-export or use `TuiViewId` for
`ViewState`, preserving the existing built-in aliases where current imports
expect `View`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm vitest run src/views/plugins/loader.test.ts`

Expected: PASS for all contract validation cases.

## Task 2: Implement Plugin Discovery and Normalization

**Files:**
- Create: `src/views/plugins/loader.ts`
- Modify: `src/views/plugins/loader.test.ts`

- [ ] **Step 1: Add failing loader tests using temporary plugin modules**

Cover configuration and module behavior with temporary directories:

```ts
function makePluginHome(input: { config: string; plugins: Record<string, string> }): string {
  const root = mkdtempSync(join(tmpdir(), 'afk-tui-plugin-'));
  const configDir = join(root, '.afk');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'plugins.yml'), input.config);
  for (const [id, source] of Object.entries(input.plugins)) {
    const distDir = join(configDir, 'plugins', id, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), source);
  }
  return root;
}

function fixtureEntry() {
  return (homeDir: string, pluginId: string) => join(homeDir, '.afk', 'plugins', pluginId, 'dist', 'index.mjs');
}

it('loads only enabled plugins and namespaces their views', async () => {
  const root = makePluginHome({
    config: 'plugins:\n  - id: enabled\n    enabled: true\n  - id: disabled\n    enabled: false\n',
    plugins: {
      enabled: `export default { id: 'enabled', name: 'Enabled', views: [{ id: 'status', title: 'Status', shortcut: 'z', render: () => null }] }`,
      disabled: `export default { id: 'disabled', name: 'Disabled', views: [] }`,
    },
  });

  await expect(loadTuiViews({ homeDir: root, resolveEntry: fixtureEntry() })).resolves.toMatchObject([
    { id: 'plugin:enabled:status', pluginId: 'enabled', shortcut: 'z' },
  ]);
});

it('accepts a named plugin export and skips malformed or missing plugins', async () => {
  const root = makePluginHome({
    config: 'plugins:\n  - id: named\n  - id: malformed\n  - id: missing\n',
    plugins: {
      named: `export const plugin = { id: 'named', name: 'Named', views: [] }`,
      malformed: `export default { id: 'malformed' }`,
    },
  });

  await expect(loadTuiViews({ homeDir: root, resolveEntry: fixtureEntry() })).resolves.toEqual([]);
});
```

Import `mkdtempSync`, `mkdirSync`, `rmSync`, and `writeFileSync` from `node:fs`,
`tmpdir` from `node:os`, and `join` from `node:path`. Each test must call
`rmSync(root, { recursive: true, force: true })` in a `finally` block.
Production resolution remains `index.js`.

- [ ] **Step 2: Run the focused loader tests and verify they fail**

Run: `pnpm vitest run src/views/plugins/loader.test.ts`

Expected: FAIL because `loadTuiViews` is not implemented.

- [ ] **Step 3: Implement YAML discovery, dynamic import, and normalization**

The loader should expose a testable dependency-injected entry point:

```ts
export interface LoadTuiViewsOptions {
  homeDir?: string;
  resolveEntry?: (homeDir: string, pluginId: string) => string;
  warn?: (message: string, error?: unknown) => void;
}

export async function loadTuiViews(options: LoadTuiViewsOptions = {}): Promise<LoadedTuiView[]> {
  const homeDir = options.homeDir ?? homedir();
  const warn = options.warn ?? ((message, error) => fileLogger.warn({ err: error }, message));
  const entries = readPluginConfig(join(homeDir, '.afk', 'plugins.yml'), warn);
  const accepted: LoadedTuiView[] = [];
  const usedIds = new Set<string>(['tasks', 'backlogs', 'projects', 'board']);
  const usedShortcuts = new Set(['t', 'b', 'p']);
  const seenPlugins = new Set<string>();

  for (const entry of entries) {
    if (entry.enabled === false || seenPlugins.has(entry.id)) continue;
    seenPlugins.add(entry.id);
    const loaded = await importPlugin(entry.id, homeDir, options.resolveEntry, warn);
    if (!loaded) continue;
    for (const view of loaded.views) {
      const id = `plugin:${loaded.id}:${view.id}` as TuiViewId;
      if (usedIds.has(id) || usedShortcuts.has(view.shortcut)) {
        warn(`Skipping conflicting TUI plugin view ${id}`);
        continue;
      }
      usedIds.add(id);
      usedShortcuts.add(view.shortcut);
      accepted.push({ id, pluginId: loaded.id, title: view.title, shortcut: view.shortcut, render: view.render });
    }
  }
  return accepted;
}
```

Use `load` from `js-yaml`, `pathToFileURL` for dynamic imports, and normalize
default/named exports before validation. Do not pass imported plugin objects
outside the loader.

- [ ] **Step 4: Add conflict and failure tests**

Add exact assertions for built-in shortcut precedence, duplicate plugin IDs,
duplicate namespaced view IDs, and import errors. Assert that `warn` receives
the plugin ID and that the returned list still contains valid plugins.

- [ ] **Step 5: Run loader tests**

Run: `pnpm vitest run src/views/plugins/loader.test.ts`

Expected: PASS with all discovery, validation, isolation, and conflict cases.

## Task 3: Integrate Plugin IDs into the Active State Navigation Safely

**Files:**
- Modify: `src/views/board/types.ts`
- Modify: `src/views/app/state/initialState.ts`
- Modify: `src/views/app/state/StateContext.tsx`
- Modify: `src/views/app/actions/handlers.ts`
- Test: `src/views/app/state/StateContext.test.tsx` or the nearest existing state reducer test file

- [ ] **Step 1: Add failing navigation tests**

Verify the active state provider accepts a host-provided plugin ID and rejects
an arbitrary ID:

```ts
const pluginViewId = 'plugin:example:status' as const;

expect(isTuiViewId(pluginViewId)).toBe(true);
expect(isTuiViewId('plugin:unknown')).toBe(false);
expect(appReducer(initialState, { type: 'navigate:switch', payload: { view: pluginViewId } }, new Set([pluginViewId]))
  .viewStack.at(-1)?.view).toBe(pluginViewId);
expect(appReducer(initialState, { type: 'navigate:switch', payload: { view: 'plugin:unknown' } }, new Set([pluginViewId])))
  .toEqual(initialState);
```

- [ ] **Step 2: Run the state test and verify it fails**

Run: `pnpm vitest run src/views/app/state/StateContext.test.tsx`

Expected: FAIL because the reducer currently accepts only the built-in view
type and has no allowed-view set.

- [ ] **Step 3: Make the state provider accept host-provided plugin IDs**

Keep the built-in set explicit and make the reducer validate the target set:

```ts
const BUILTIN_VIEWS = new Set<BuiltinView>(['tasks', 'backlogs', 'projects', 'board']);

export function isBuiltinView(view: string): view is BuiltinView {
  return BUILTIN_VIEWS.has(view as BuiltinView);
}

export function isTuiViewId(view: string): view is TuiViewId {
  return isBuiltinView(view) || /^plugin:[^:]+:[^:]+$/.test(view);
}

export function appReducer(
  state: AppState,
  action: AppAction,
  allowedViews: ReadonlySet<string> = BUILTIN_VIEWS,
): AppState {
// In the existing `navigate:switch` case:
const rawView = action.payload?.view;
if (!rawView || !allowedViews.has(rawView)) return state;
const view = rawView as TuiViewId;
  // Keep all other existing reducer cases unchanged.
}
```

Add `allowedViews: ReadonlySet<string> = BUILTIN_VIEWS` to the existing
`appReducer` signature, append `{ view, context: {} }` in the existing case, and
pass `allowedViews` through the `StateProvider` closure. All other reducer
cases stay in the same function; do not create a second runtime reducer.

Wrap `appReducer` in `StateProvider` with the immutable set of built-in plus
loaded plugin IDs. Update `createActions` to accept `TuiViewId` instead of an
untyped string. Keep `src/views/board/navigation/useNavigation.ts` unchanged;
the running app uses `StateContext`, and the old hook is not on the active
render path.

- [ ] **Step 4: Run state and existing app tests**

Run: `pnpm vitest run src/views/app/state src/views/app`

Expected: PASS, with existing built-in navigation behavior unchanged.

## Task 4: Add the Error-Isolated Plugin View Boundary

**Files:**
- Create: `src/views/plugins/PluginViewBoundary.tsx`
- Create: `src/views/plugins/PluginViewBoundary.test.tsx`

- [ ] **Step 1: Add failing boundary tests**

Test a successful render and a render callback that throws using the existing
Ink `renderToString` helper:

```tsx
it('renders the plugin view with the narrow context', () => {
  const renderPlugin = vi.fn((pluginContext: TuiPluginContext) => <Text>{pluginContext.cwd}</Text>);
  const output = renderToString(<PluginViewBoundary view={{ id: 'plugin:example:status', pluginId: 'example', title: 'Status', shortcut: 'z', render: renderPlugin }} context={context} />);
  expect(output).toContain(context.cwd);
  expect(renderPlugin).toHaveBeenCalledWith(context);
});

it('renders an error panel instead of propagating plugin render failures', () => {
  const renderPlugin = () => { throw new Error('plugin exploded'); };
  const output = renderToString(<PluginViewBoundary view={{ id: 'plugin:example:status', pluginId: 'example', title: 'Status', shortcut: 'z', render: renderPlugin }} context={context} />);
  expect(output).toContain('plugin exploded');
});
```

Import `renderToString` and `Text` from `ink`, and `TuiPluginContext` from
`src/views/plugins/types.ts`; do not introduce a new renderer dependency.

- [ ] **Step 2: Run boundary tests and verify they fail**

Run: `pnpm vitest run src/views/plugins/PluginViewBoundary.test.tsx`

Expected: FAIL because the boundary does not exist.

- [ ] **Step 3: Implement the smallest boundary**

Use a direct `try/catch` around the plugin render callback:

```tsx
export function PluginViewBoundary({ view, context }: Props) {
  try {
    return <PluginErrorBoundary pluginId={view.pluginId ?? 'unknown'}>{view.render?.(context)}</PluginErrorBoundary>;
  } catch (error) {
    return <PluginErrorPanel pluginId={view.pluginId ?? 'unknown'} error={error} />;
  }
}
```

The error panel must only show the plugin ID and sanitized error message. It
must not print source code or stack traces to the TUI.

- [ ] **Step 4: Run boundary tests**

Run: `pnpm vitest run src/views/plugins/PluginViewBoundary.test.tsx`

Expected: PASS for normal rendering and synchronous plugin render errors.

## Task 5: Wire Plugin Loading into the TUI

**Files:**
- Modify: `src/views/app/DashboardEntry.tsx`
- Modify: `src/views/app/AppContent.tsx`
- Modify: `src/views/board/views/Header.tsx`
- Modify: `src/views/board/views/Footer.tsx`
- Modify: `src/views/board/views/HelpDialog.tsx`
- Test: `src/views/app/AppContent.test.tsx`
- Test: `tests/e2e/notification.test.ts` or a new focused TUI plugin E2E test

- [ ] **Step 1: Add failing AppContent tests**

Cover three cases:

Use the existing `renderToString` helper and render a plugin view through a
`StateProvider` configured with its allowed ID. Assert that the output contains
the plugin text and does not contain the built-in task cockpit text. Keep the
existing built-in test cases unchanged.

The new test should use this shape:

```tsx
const pluginView: LoadedTuiView = {
  id: 'plugin:example:status',
  pluginId: 'example',
  title: 'Status',
  shortcut: 'z',
  render: context => <Text>plugin cwd: {context.cwd}</Text>,
};

const output = renderToString(
  <StateProvider allowedViews={new Set(['tasks', 'backlogs', 'projects', 'board', pluginView.id])}>
    <AppContent {...props} pluginViews={[pluginView]} cwd="/tmp/plugin-test" />
  </StateProvider>,
);

expect(output).toContain('plugin cwd: /tmp/plugin-test');
expect(output).not.toContain('recent activity');
```

- [ ] **Step 2: Run the focused app test and verify it fails**

Run: `pnpm vitest run src/views/app/AppContent.test.tsx`

Expected: FAIL because `AppContent` has no plugin view prop or render branch.

- [ ] **Step 3: Load plugins in `DashboardEntry` and pass immutable descriptors**

Load once during dashboard startup, keep failure isolation, and use the
existing current working directory as the context source:

```tsx
const [pluginViews, setPluginViews] = useState<readonly LoadedTuiView[]>([]);

useEffect(() => {
  let cancelled = false;
  void loadTuiViews().then(views => {
    if (!cancelled) setPluginViews(views);
  });
  return () => { cancelled = true; };
}, []);
```

Pass `pluginViews` and `cwd`/workspace inputs to both `StateProvider` and
`AppContent`. Do not delay built-in TUI startup on plugin loading errors.

- [ ] **Step 4: Render plugin pages in `AppContent`**

Use an explicit built-in guard and plugin lookup:

```tsx
const pluginView = pluginViews.find(view => view.id === currentView);
const isPluginView = Boolean(pluginView);

{isPluginView && pluginView?.render ? (
  <PluginViewBoundary
    view={pluginView}
    context={{ cwd, workspace, notify: message => dispatch({ type: 'notification:show', payload: { type: 'info', message } }) }}
  />
) : (
  <Body {...bodyProps} />
)}
```

Before the numeric built-in shortcuts, match the input against accepted plugin
views and dispatch `actions.switchView(pluginView.id)`. Do not let plugin
shortcuts run while search mode, detail mode, or help mode owns the input.

Pass `pluginViews` into `Header`, `Footer`, and `HelpDialog`. Header renders
each accepted plugin as `<shortcut> <title>` after the four built-in tabs;
HelpDialog lists the same mapping on separate lines; Footer keeps its existing
built-in hints and appends a compact plugin shortcut list when there is room.

Guard all existing item selection, project detail, pagination, and action
logic with `isBuiltinView(currentView)` so plugin views use empty built-in data
and cannot trigger built-in mutations accidentally.

- [ ] **Step 5: Add a fixture plugin E2E test**

Create a temporary `~/.afk/plugins.yml` and plugin entry point in the test
fixture setup. Assert the plugin shortcut/page appears and renders while the
existing built-in boot tests still pass. Ensure the fixture is removed in the
test teardown.

- [ ] **Step 6: Run TUI tests**

Run: `pnpm vitest run src/views/app/AppContent.test.tsx src/views/app/state tests/e2e/notification.test.ts`

Expected: PASS with the plugin page rendering and built-in behavior preserved.

## Task 6: Update Documentation and Validate the Whole Repository

**Files:**
- Modify: `CLAUDE.md:47-53`
- Modify: `docs/TESTING.md:25-40`
- Modify: `docs/TESTING_zh.md:25-40`

- [ ] **Step 1: Replace stale TUI Core documentation**

Document the trusted external plugin location, export shape, enabled config,
shortcut precedence, and no-sandbox warning. Remove examples importing the
deleted `KeyboardDispatcher` and `ViewRegistry` files.

- [ ] **Step 2: Run focused validation**

Run:

```bash
pnpm vitest run src/views/plugins src/views/app/AppContent.test.tsx src/views/board/navigation
pnpm typecheck
git diff --check
```

Expected: all focused tests pass, typecheck exits 0, and `git diff --check`
prints no errors.

- [ ] **Step 3: Run the full root verification**

Run: `pnpm test`

Expected: the existing root suite passes with the plugin tests included.

- [ ] **Step 4: Run desktop verification if shared root changes affect it**

Run:

```bash
pnpm --dir desktop-client test
pnpm --dir desktop-client build
AFK_E2E_PORT=5175 pnpm --dir desktop-client e2e
```

Expected: all desktop tests, build, and E2E tests pass; generated
`desktop-client/test-results/` is removed before handoff.
