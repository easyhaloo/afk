# TUI Operational Subviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the read-only Ink dashboard as four mutually exclusive operational subviews with full-screen details, compact responsive rows, and context-aware navigation chrome.

**Architecture:** `AppContent` remains the owner of input and data selection, while a pure layout helper calculates usable list rows. `Header`, `Footer`, shared row rendering, and `DetailScreen` receive explicit view/detail context so they do not infer semantics from tracker labels. The existing management-provider data flow and only its read-only browser/session actions remain unchanged.

**Tech Stack:** TypeScript, React 19, Ink 7, Vitest, node-pty terminal regression tests.

---

## File Structure

- Create: `src/views/board/layout.ts` — fixed chrome and responsive-width calculations.
- Create: `src/views/board/layout.test.ts` — pure layout calculation coverage.
- Create: `src/views/board/views/OperationalRow.tsx` — stable one-line row grammar shared by list views.
- Create: `src/views/board/views/OperationalRow.test.tsx` — row truncation and selection rendering coverage.
- Create: `src/views/app/state/StateContext.test.ts` — navigation and selection restoration coverage.
- Modify: `src/views/app/state/StateContext.tsx` — preserve list selection/scroll state while opening and leaving detail.
- Modify: `src/views/app/AppContent.tsx` — remove separator/title chrome, use layout metrics, and pass contextual chrome props.
- Modify: `src/views/board/views/Header.tsx` — render view navigation and active item count.
- Modify: `src/views/board/views/Footer.tsx` — render state-specific shortcut hints.
- Modify: `src/views/board/views/{TaskListView,BacklogListView,ProjectListView}.tsx` — use the shared one-line row grammar.
- Modify: `src/views/board/board/BoardView.tsx` — list-only board; remove split preview behavior.
- Modify: `src/views/board/views/DetailScreen.tsx` — full-screen grouped detail layouts with Markdown description rendering.
- Modify: `src/views/board/views/HelpDialog.tsx` and `src/views/board/views/index.ts` — describe/export only the supported subview controls.
- Modify: `src/views/board/{integration.test.tsx,board/BoardView.test.tsx}` — canonical, read-only rendering regression coverage.
- Modify: `tests/e2e/notification.test.ts` — add PTY layout captures at 80, 100, 120, and 160 columns if the existing dashboard fixture can be reused; otherwise create `tests/e2e/dashboard-layout.test.ts` with the same setup helper.

### Task 1: Make detail navigation preserve list context

**Files:**
- Modify: `src/views/app/state/StateContext.tsx`
- Create: `src/views/app/state/StateContext.test.ts`

- [ ] **Step 1: Write reducer tests for detail/list navigation.**

```ts
import { describe, expect, it } from 'vitest';
import { appReducer } from './StateContext';
import { initialState } from './initialState';

describe('appReducer detail navigation', () => {
  it('preserves selection and scroll offset when closing detail', () => {
    const listed = { ...initialState, selectedIndex: 4, scrollOffset: 2 };
    const detailed = appReducer(listed, { type: 'navigate:goto-detail' });
    expect(appReducer(detailed, { type: 'navigate:goto-list' })).toMatchObject({
      detailView: 'list', selectedIndex: 4, scrollOffset: 2,
    });
  });

  it('resets selection only when switching top-level subviews', () => {
    const state = { ...initialState, selectedIndex: 4, scrollOffset: 2 };
    expect(appReducer(state, { type: 'navigate:switch', payload: { view: 'backlogs' } }))
      .toMatchObject({ detailView: 'list', selectedIndex: 0, scrollOffset: 0 });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails because the reducer is not exported and list navigation resets selection.**

Run: `pnpm exec vitest run src/views/app/state/StateContext.test.ts`

Expected: FAIL with an export error or an assertion that `selectedIndex` is `0`.

- [ ] **Step 3: Export the reducer and retain selection when leaving detail.**

```ts
export function appReducer(state: AppState, action: AppAction): AppState {
  // existing reducer cases
}

case 'navigate:goto-list':
  return { ...state, detailView: 'list' };
```

Replace `useReducer(reducer, initialState)` with `useReducer(appReducer, initialState)`.
Remove the separator animation effect and `separator:tick` usage because the redesigned shell has no breathing separator.

- [ ] **Step 4: Run the focused test and typecheck.**

Run: `pnpm exec vitest run src/views/app/state/StateContext.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the navigation state change.**

```bash
git add src/views/app/state/StateContext.tsx src/views/app/state/StateContext.test.ts
git commit -m "refactor(tui): preserve list context from detail"
```

### Task 2: Add pure layout metrics and a shared operational row

**Files:**
- Create: `src/views/board/layout.ts`
- Create: `src/views/board/layout.test.ts`
- Create: `src/views/board/views/OperationalRow.tsx`
- Create: `src/views/board/views/OperationalRow.test.tsx`
- Modify: `src/views/board/views/index.ts`

- [ ] **Step 1: Write failing layout and row tests.**

```ts
import { describe, expect, it } from 'vitest';
import { getListViewportHeight, getRowColumns } from './layout';

describe('getListViewportHeight', () => {
  it('removes the four fixed dashboard rows from terminal height', () => {
    expect(getListViewportHeight(24, { header: 1, context: 1, footer: 1, spacer: 1 })).toBe(20);
  });
});

describe('getRowColumns', () => {
  it('hides summary below 80 columns', () => {
    expect(getRowColumns(79).summary).toBe(false);
    expect(getRowColumns(80).summary).toBe(true);
  });
});
```

```tsx
it('renders only status, mode, and title at compact widths', () => {
  const output = renderToString(
    <OperationalRow width={79} selected status="ready" mode="afk" id="42"
      title="修复中文显示宽度" summary="parent 10 · depends 7" />,
  );
  expect(output).toContain('ready');
  expect(output).toContain('修复中文显示宽度');
  expect(output).not.toContain('depends 7');
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail.**

Run: `pnpm exec vitest run src/views/board/layout.test.ts src/views/board/views/OperationalRow.test.tsx`

Expected: FAIL because the module and component do not exist.

- [ ] **Step 3: Implement pure metrics and the reusable single-line row.**

```ts
export interface FixedChrome { header: number; context: number; footer: number; spacer: number; }
export const getListViewportHeight = (height: number, chrome: FixedChrome) =>
  Math.max(1, height - chrome.header - chrome.context - chrome.footer - chrome.spacer);

export const getRowColumns = (width: number) => ({
  summary: width >= 80,
  metadataWidth: width >= 120 ? 30 : 20,
});
```

`OperationalRow` must use `truncateByVisualWidth` for title and summary,
render a fixed selection marker, and render no border. It accepts
`statusColor`, `status`, `mode`, `id`, `title`, `summary`, `selected`, and
`width`; it hides the summary when `getRowColumns(width).summary` is false.
Export the component from `views/index.ts`.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `pnpm exec vitest run src/views/board/layout.test.ts src/views/board/views/OperationalRow.test.tsx && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the layout primitives.**

```bash
git add src/views/board/layout.ts src/views/board/layout.test.ts src/views/board/views/OperationalRow.tsx src/views/board/views/OperationalRow.test.tsx src/views/board/views/index.ts
git commit -m "feat(tui): add operational row layout primitives"
```

### Task 3: Convert header, footer, and help to contextual chrome

**Files:**
- Modify: `src/views/board/views/Header.tsx`
- Modify: `src/views/board/views/Footer.tsx`
- Modify: `src/views/board/views/HelpDialog.tsx`
- Create: `src/views/board/views/Header.test.tsx`
- Create: `src/views/board/views/Footer.test.tsx`

- [ ] **Step 1: Write chrome rendering tests.**

```tsx
it('marks the active Backlogs subview in the header', () => {
  const output = renderToString(<Header view="backlogs" tasksCount={1} backlogsCount={4} projectsCount={2} />);
  expect(output).toContain('1 tasks');
  expect(output).toContain('2 backlogs 4');
});

it('shows detail-only shortcuts in the footer', () => {
  const output = renderToString(<Footer view="backlogs" detail />);
  expect(output).toContain('ESC back');
  expect(output).toContain('o open');
  expect(output).not.toContain('↑↓');
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `pnpm exec vitest run src/views/board/views/Header.test.tsx src/views/board/views/Footer.test.tsx`

Expected: FAIL because Header lacks tab labels and Footer accepts no context props.

- [ ] **Step 3: Implement the contextual chrome.**

`Header` renders four compact labels in one row: `1 tasks`, `2 backlogs`,
`3 projects`, and `4 board`. Highlight only the active view and append its
count. `Footer` accepts `{ view, detail, search }`; list mode renders
`↑↓ move · enter detail · o open · / search · ? help`, detail mode renders
`b/ESC back · o open · ? help`, and task list mode adds `a attach`.

`HelpDialog` must describe those exact commands and call the `tasks` view
“tasks”, not “sessions”. It must not list lifecycle-changing commands.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `pnpm exec vitest run src/views/board/views/Header.test.tsx src/views/board/views/Footer.test.tsx && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit contextual chrome.**

```bash
git add src/views/board/views/Header.tsx src/views/board/views/Footer.tsx src/views/board/views/HelpDialog.tsx src/views/board/views/Header.test.tsx src/views/board/views/Footer.test.tsx
git commit -m "feat(tui): add contextual dashboard chrome"
```

### Task 4: Render four compact, independent list subviews

**Files:**
- Modify: `src/views/board/views/TaskListView.tsx`
- Modify: `src/views/board/views/BacklogListView.tsx`
- Modify: `src/views/board/views/ProjectListView.tsx`
- Modify: `src/views/board/views/ListView.tsx`
- Modify: `src/views/board/board/BoardView.tsx`
- Modify: `src/views/board/board/BoardView.test.tsx`
- Modify: `src/views/board/integration.test.tsx`

- [ ] **Step 1: Write rendering tests for canonical compact rows and list-only board behavior.**

```tsx
it('does not render backlog description in a backlog list row', () => {
  const output = renderToString(<BacklogListView backlogs={[backlog]} selected={0} scrollOffset={0} viewportHeight={10} width={100} />);
  expect(output).toContain('[verification]');
  expect(output).toContain('(hitl)');
  expect(output).not.toContain(backlog.description);
});

it('does not render a preview panel in the board subview', () => {
  const output = renderToString(<BoardView backlogs={[backlog]} selectedIndex={0} scrollOffset={0} viewportHeight={10} width={160} />);
  expect(output).toContain('backlog 42');
  expect(output).not.toContain('preview');
});
```

- [ ] **Step 2: Run focused tests and confirm they fail.**

Run: `pnpm exec vitest run src/views/board/board/BoardView.test.tsx src/views/board/integration.test.tsx`

Expected: FAIL because the current board renders `PreviewPanel` at wide widths
and list rows include description metadata.

- [ ] **Step 3: Migrate Task, Backlog, and Project rows to `OperationalRow`.**

Pass the terminal width from `AppContent` to every list view. The backlog and
board summary must be exactly `parent <id-or-dash> · depends <count> · <tags>`.
Task summary must use session, branch/worktree, progress, and relative time;
project summary must use namespace/branch and a truncated description.

Remove list borders and any per-row multiline rendering. `ListView` must render
only `items.slice(scrollOffset, scrollOffset + viewportHeight)` without
artificially distributing empty vertical space between rows.

- [ ] **Step 4: Make BoardView a list-only subview.**

Replace the width-driven split-panel code with the same canonical backlog rows
used by `BacklogListView`. Keep board-specific state coloring and the board
empty state, but delete the `PreviewPanel` import and rendering branch. Do not
delete `PreviewPanel.tsx` in this task; it remains outside the active export
surface until a later cleanup confirms no other consumer.

- [ ] **Step 5: Run focused tests, typecheck, and the view test suite.**

Run: `pnpm exec vitest run src/views/board/board/BoardView.test.tsx src/views/board/integration.test.tsx src/views/board/utils.test.tsx && pnpm typecheck`

Expected: PASS; provider `claim` spies remain untouched.

- [ ] **Step 6: Commit the list subviews.**

```bash
git add src/views/board/views/TaskListView.tsx src/views/board/views/BacklogListView.tsx src/views/board/views/ProjectListView.tsx src/views/board/views/ListView.tsx src/views/board/board/BoardView.tsx src/views/board/board/BoardView.test.tsx src/views/board/integration.test.tsx
git commit -m "refactor(tui): render compact operational subviews"
```

### Task 5: Replace the list with grouped full-screen detail subviews

**Files:**
- Modify: `src/views/board/views/DetailScreen.tsx`
- Create: `src/views/board/views/DetailScreen.test.tsx`
- Modify: `src/views/app/AppContent.tsx`

- [ ] **Step 1: Write detail and top-level keyboard tests.**

```tsx
it('renders backlog relationships and Markdown description only in detail', () => {
  const output = renderToString(<DetailScreen item={backlog} view="backlogs" height={30} width={100} />);
  expect(output).toContain('parent');
  expect(output).toContain('depends on');
  expect(output).toContain('github:org/repo#42');
  expect(output).toContain('Verify the request handling path.');
});
```

The reducer assertions created in Task 1 are the keyboard navigation coverage
for entering and leaving a detail subview. This task uses `renderToString` only
for deterministic full-screen detail output; do not add a second Ink rendering
test framework.

- [ ] **Step 2: Run the focused tests and confirm they fail.**

Run: `pnpm exec vitest run src/views/board/views/DetailScreen.test.tsx src/views/app/state/StateContext.test.ts`

Expected: FAIL because detail currently has a boxed pane, fixed generic footer,
and AppContent uses inaccurate viewport sizing/chrome.

- [ ] **Step 3: Implement full-screen grouped detail rendering.**

`DetailScreen` owns the entire terminal content in detail mode. Replace the
ASCII box with a compact header, grouped metadata sections, Markdown-rendered
description, and the contextual detail footer. Do not expose claim, transition,
tag, launch, kill, merge, or branch creation controls.

In `AppContent`, define fixed chrome as:

```ts
const chrome = { header: 1, context: 1, footer: 1, spacer: 1 };
const viewportHeight = getListViewportHeight(dimensions.height, chrome);
```

Render only `DetailScreen` while `isDetailMode` is true. In list mode render
`Header`, a single context/search row, the active one of the four list subviews,
and `Footer`. Remove `BreathingSeparator` imports and uses. Pass `width` to
list views and `detail={isDetailMode}`/`search={state.isSearchMode}` to Footer.

- [ ] **Step 4: Run focused tests, then typecheck.**

Run: `pnpm exec vitest run src/views/board/views/DetailScreen.test.tsx src/views/app/state/StateContext.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit full-screen detail navigation.**

```bash
git add src/views/board/views/DetailScreen.tsx src/views/board/views/DetailScreen.test.tsx src/views/app/AppContent.tsx
git commit -m "feat(tui): show detail as a full subview"
```

### Task 6: Verify responsive terminal behavior and the read-only boundary

**Files:**
- Create: `tests/e2e/dashboard-layout.test.ts`
- Modify: `src/views/app/actions/handlers.test.ts`
- Modify: `src/views/board/integration.test.tsx`

- [ ] **Step 1: Add a PTY dashboard capture helper and responsive rendering assertions.**

```ts
import { spawn } from 'node-pty';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = join(__dirname, '../../dist/index.js');

async function captureDashboard(cols: number): Promise<string> {
  const output: string[] = [];
  const proc = spawn(process.execPath, [distPath], {
    cols,
    rows: 30,
    env: { ...process.env, NO_TMUX: '1' },
  });
  proc.onData(data => output.push(data));
  await new Promise(resolve => setTimeout(resolve, 800));
  proc.write('\x1B');
  await new Promise(resolve => setTimeout(resolve, 1800));
  proc.kill();
  return output.join('');
}

it.each([80, 100, 120, 160])('renders one dashboard subview at %i columns', async (cols) => {
  const frame = await captureDashboard(cols);
  expect(frame).toContain('AFK Dashboard');
  expect(frame).not.toContain('preview');
});
```

Copy the existing `node-pty` availability guard and capture helper from
`tests/e2e/notification.test.ts` into the new dashboard test. Skip only when
the guard reports `node-pty` is unavailable. Retain and extend the canonical
provider `claim` spy assertion already present in `src/views/board/integration.test.tsx`; do not create a second provider fixture in this PTY test.

- [ ] **Step 2: Run focused UI and PTY tests.**

Run: `pnpm exec vitest run src/views src/views/app/actions/handlers.test.ts tests/e2e/dashboard-layout.test.ts --reporter=verbose`

Expected: PASS, or the PTY suite is skipped through its pre-existing
availability guard. Review generated captures in `/tmp/afk-e2e-screenshots/`.

- [ ] **Step 3: Run complete verification.**

Run:

```bash
pnpm typecheck
pnpm build
pnpm exec vitest run --exclude 'tests/e2e/**' --reporter=verbose
pnpm exec vitest run tests/e2e/notification.test.ts tests/e2e/dashboard-layout.test.ts --reporter=verbose
git diff --check
```

Expected: all commands exit `0`; no TUI file imports tracker-label parsers or
invokes backlog lifecycle mutation methods.

- [ ] **Step 4: Commit final verification changes.**

```bash
git add tests/e2e/dashboard-layout.test.ts src/views/app/actions/handlers.test.ts src/views/board/integration.test.tsx
git commit -m "test(tui): cover operational subview layout"
```
