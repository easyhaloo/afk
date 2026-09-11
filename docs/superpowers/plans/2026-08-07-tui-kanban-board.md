# TUI Parallel Kanban Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Board list with a responsive, read-only Kanban that exposes a four-stage primary pipeline, an exception queue, and a Done archive with lane-aware keyboard navigation.

**Architecture:** Add a pure board model for state grouping, four primary lanes, a conditional Attention column, a Done archive column, responsive windows, and selection targets. Keep provider data unchanged; `AppContent` adapts board key events to the model, while `BoardView` renders named flow summaries, icon-based lane headers, and fixed-height cards inside the existing Header/Context/Viewport/Footer shell. Backlog list rows use the same icon vocabulary but defer parent, dependency, and tag metadata to details.

**Tech Stack:** TypeScript, React 19, Ink 7, Vitest, node-pty PTY tests.

---

## Files and Responsibilities

- Create `src/views/board/board/model.ts`: canonical seven-lane order, grouping, responsive lane-window calculation, and board selection navigation.
- Create `src/views/board/board/model.test.ts`: pure model tests for state mapping, counts, windows, and navigation.
- Create `src/views/board/board/BoardCard.tsx`: two-row read-only backlog card with visual-width-safe truncation.
- Create `src/views/board/board/BoardLane.tsx`: icon lane heading, count, divider, and clipped card stack.
- Modify `src/views/board/board/BoardView.tsx`: render grouped lanes, selected card, responsive lane window, pipeline strip, and empty state.
- Modify `src/views/board/board/BoardView.test.tsx`: render lanes/cards at compact, medium, and wide widths and verify viewport clipping.
- Modify `src/views/board/layout.ts`: expose board layout thresholds and lane width calculations without changing list layout behavior.
- Modify `src/views/app/AppContent.tsx`: use board model navigation for arrow/g/G keys and pass board selection context to `BoardView`; retain existing navigation for Tasks, Backlogs, and Projects.
- Modify `tests/e2e/dashboard-layout.test.ts`: assert the icon/count pipeline strip, board card rendering, board keyboard navigation, detail entry, and fixed Header/Footer under PTY.

### Task 1: Define the Pure Board Model

**Files:**
- Create: `src/views/board/board/model.ts`
- Test: `src/views/board/board/model.test.ts`

- [ ] **Step 1: Write failing tests for state grouping and column composition**

Create fixtures covering one item in every `BacklogState`, then assert the four primary columns, one combined Attention column, and one Done archive column:

```ts
expect(getBoardColumns(groupBacklogsByState(items)).map(column => column.key)).toEqual([
  'ready', 'in_progress', 'verification', 'merge_ready', 'attention', 'done',
]);
```

Also assert an empty input still returns seven lanes with zero counts and that grouping preserves input order inside each lane.

- [ ] **Step 2: Run the model test and verify the expected failure**

Run:

```bash
npm test -- --run src/views/board/board/model.test.ts
```

Expected: FAIL because `model.ts` and its exported functions do not yet exist.

- [ ] **Step 3: Implement the minimal lane model**

Define these types and functions:

```ts
export const BOARD_LANES = [
  { state: 'ready', label: 'Ready', shortLabel: 'ready' },
  { state: 'in_progress', label: 'In Progress', shortLabel: 'progress' },
  { state: 'verification', label: 'Verification', shortLabel: 'verify' },
  { state: 'merge_ready', label: 'Merge Ready', shortLabel: 'merge' },
  { state: 'rework', label: 'Rework', shortLabel: 'rework' },
  { state: 'blocked', label: 'Blocked', shortLabel: 'blocked' },
  { state: 'done', label: 'Done', shortLabel: 'done' },
] as const;

export interface BoardLane {
  state: BacklogViewModel['state'];
  label: string;
  shortLabel: string;
  items: BacklogViewModel[];
}

export function groupBacklogsByState(items: BacklogViewModel[]): BoardLane[];
```

Use a `Map` keyed by state and iterate `BOARD_LANES` so the function always emits the same seven lanes.

- [ ] **Step 4: Add responsive window and navigation tests**

Test:

```ts
expect(getBoardLayout(160)).toMatchObject({ visibleLaneCount: 4 });
expect(getBoardLayout(120)).toMatchObject({ visibleLaneCount: 3 });
expect(getBoardLayout(80)).toMatchObject({ visibleLaneCount: 1 });
expect(getBoardVisibleLaneIndexes(3, 7, 3)).toEqual([2, 3, 4]);
```

For navigation, use lane fixtures with two cards in `ready`, one in `verification`, and two in `done`. Assert Up/Down stay in the focused lane, Left/Right skip empty lanes, and lateral movement clamps the card ordinal to the target lane length.

- [ ] **Step 5: Implement the pure layout/navigation helpers**

Export:

```ts
export interface BoardLayout { visibleLaneCount: 1 | 3 | 4; laneWidth: number; compact: boolean; }
export function getBoardLayout(width: number): BoardLayout;
export function getBoardVisibleLaneIndexes(focusedLane: number, laneCount: number, visibleLaneCount: number): number[];
export function getBoardSelectionTarget(
  lanes: BoardLane[], selectedId: string | undefined, direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom',
): string | undefined;
```

`getBoardSelectionTarget` returns a backlog ID, not an array index, so filtering and lane regrouping cannot select the wrong item. Return the current ID for a boundary/no-op and `undefined` only when there are no items.

- [ ] **Step 6: Run model tests and commit**

Run:

```bash
npm test -- --run src/views/board/board/model.test.ts
```

Expected: all model tests pass. Commit only the model and model tests:

```bash
git add src/views/board/board/model.ts src/views/board/board/model.test.ts
git commit -m "feat(tui): add kanban board model"
```

### Task 2: Build Fixed-Height Board Cards and Lanes

**Files:**
- Create: `src/views/board/board/BoardCard.tsx`
- Create: `src/views/board/board/BoardLane.tsx`
- Modify: `src/views/board/board/BoardView.test.tsx`

- [ ] **Step 1: Write failing card/lane rendering tests**

Add tests asserting a card contains the backlog ID, execution mode icon, and title but excludes the full description and provider URL. Assert a lane renders its state icon and count, and that the lane body never exceeds the supplied height.

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
npm test -- --run src/views/board/board/BoardView.test.tsx
```

Expected: FAIL because `BoardCard` and `BoardLane` are not present and `BoardView` still renders the old flat title/list.

- [ ] **Step 3: Implement `BoardCard`**

Render a fixed two-row box with `overflow="hidden"`:

```tsx
<Box flexDirection="column" height={3} overflow="hidden">
  <Text>{selected ? '▶ ' : '  '}#{backlog.id} · {backlog.executionMode}</Text>
  <Text wrap="truncate">  {truncateByVisualWidth(backlog.title, Math.max(1, width - 2))}</Text>
</Box>
```

Use existing state colors and visual-width truncation helpers. Do not introduce clickable buttons or provider-specific labels.

- [ ] **Step 4: Implement `BoardLane`**

Render a fixed-width column with a one-row colored icon/count heading, one divider row, and a clipped card stack. Slice cards to the available height after the two heading rows. Highlight the selected lane/card without changing row height.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm test -- --run src/views/board/board/BoardView.test.tsx
```

Expected: card and lane tests pass. Commit:

```bash
git add src/views/board/board/BoardCard.tsx src/views/board/board/BoardLane.tsx src/views/board/board/BoardView.test.tsx
git commit -m "feat(tui): render kanban cards and lanes"
```

### Task 3: Replace `BoardView` with Responsive Kanban Rendering

**Files:**
- Modify: `src/views/board/board/BoardView.tsx`
- Modify: `src/views/board/layout.ts`
- Modify: `src/views/board/board/BoardView.test.tsx`

- [ ] **Step 1: Add failing responsive rendering tests**

Build fixtures across all seven states and assert:

```ts
expect(renderToString(<BoardView ... width={160} />)).toContain('○1');
expect(renderToString(<BoardView ... width={160} />)).toContain('✓1');
expect(renderToString(<BoardView ... width={120} />)).toContain('pipeline');
expect(renderToString(<BoardView ... width={80} />)).toContain('ready');
```

Assert wide output has the four primary columns, medium output has exactly three lane columns plus pipeline strip, and compact output has one focused lane plus the strip. Assert a long card list is clipped to the allocated viewport.

- [ ] **Step 2: Run tests and verify the old Board fails**

Run:

```bash
npm test -- --run src/views/board/board/BoardView.test.tsx
```

Expected: FAIL because the current Board only renders `board · N backlogs`, a divider, and flat rows.

- [ ] **Step 3: Implement responsive `BoardView`**

Group the input with `groupBacklogsByState`, find the selected lane/card, compute `getBoardLayout(width)`, and render:

```tsx
<Box height={viewportHeight} width={width} overflow="hidden" flexDirection="column">
  <PipelineStrip lanes={lanes} focusedLane={focusedLane} compact={layout.compact} />
  <Box flexDirection="row" height={Math.max(1, viewportHeight - 1)} overflow="hidden">
    {visibleLaneIndexes.map(index => <BoardLane key={lanes[index].state} ... />)}
  </Box>
</Box>
```

Keep the outer `height` contract so Header/Footer cannot be displaced. Use the selected lane to calculate the focused card's vertical slice; do not add a second provider read or mutate the view model.

- [ ] **Step 4: Run focused Board tests and commit**

Run:

```bash
npm test -- --run src/views/board/board/BoardView.test.tsx src/views/board/board/model.test.ts
```

Expected: all Kanban model, card, lane, responsive, and clipping tests pass. Commit:

```bash
git add src/views/board/board/BoardView.tsx src/views/board/layout.ts src/views/board/board/BoardView.test.tsx
git commit -m "feat(tui): replace flat board with parallel kanban"
```

### Task 4: Integrate Board-Aware Keyboard Navigation

**Files:**
- Modify: `src/views/app/AppContent.tsx`
- Modify: `src/views/app/AppContent.test.tsx`
- Modify: `src/views/board/board/model.test.ts`

- [ ] **Step 1: Write failing navigation integration tests**

Extend the AppContent/PTY fixture with multiple states. Assert that on Board:

1. `Down` selects the next card in the current lane, not the next item in the global flat input.
2. `Right` selects the same/nearest ordinal in the next non-empty lane.
3. `g` and `G` select the first/last card in the focused lane.
4. `Enter` still opens the selected backlog detail.

Keep existing Tasks/Backlogs/Projects key behavior assertions unchanged.

- [ ] **Step 2: Run the focused integration tests and verify failure**

Run:

```bash
npm test -- --run src/views/app/AppContent.test.tsx tests/e2e/dashboard-layout.test.ts
```

Expected: Board navigation assertions fail because `AppContent` currently treats Board as a flat list and only handles Up/Down.

- [ ] **Step 3: Implement Board-specific key routing**

In `AppContent`, derive the selected ID from `items[state.selectedIndex]` and use `getBoardSelectionTarget` when `currentView === 'board'`:

```ts
if (currentView === 'board' && (key.upArrow || key.downArrow)) {
  const id = getBoardSelectionTarget(lanes, selectedId, key.downArrow ? 'down' : 'up');
  if (id) dispatch({ type: 'selection:set', payload: { index: items.findIndex(item => item.id === id) } });
  return;
}
```

Apply the same pattern for left/right and `g/G`; leave the existing generic list path untouched for other views. Keep `q` global outside search mode and `b/ESC` as back behavior.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm test -- --run src/views/app/AppContent.test.tsx tests/e2e/dashboard-layout.test.ts
```

Expected: all Board navigation and existing subview navigation tests pass. Commit:

```bash
git add src/views/app/AppContent.tsx src/views/app/AppContent.test.tsx tests/e2e/dashboard-layout.test.ts src/views/board/board/model.test.ts
git commit -m "feat(tui): add lane-aware board navigation"
```

### Task 5: Full Verification and Integration Review

**Files:**
- Modify: `tests/e2e/dashboard-layout.test.ts` only if the final PTY assertions need stable fixture labels.

- [ ] **Step 1: Run Board and shell regression tests**

```bash
npm test -- --run src/views/board/board/model.test.ts src/views/board/board/BoardView.test.tsx src/views/app/AppContent.test.tsx tests/e2e/dashboard-layout.test.ts
```

Expected: all focused tests pass and real PTY cases are executed rather than skipped.

- [ ] **Step 2: Run the complete verification suite**

```bash
npm test -- --run
npm run typecheck
npm run build
git diff --check
```

Expected: no failed tests, no TypeScript errors, successful build, and no whitespace errors. If PTY tests are skipped, first verify `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper` has mode `0755` and run `node scripts/fix-permissions.mjs`.

- [ ] **Step 3: Review behavior against the accepted design**

Confirm manually in a real terminal at 80, 120, and 160 columns:

- Header and Footer remain visible with many cards.
- Wide screens show four primary lanes; medium screens show three; narrow screens show one plus the pipeline strip.
- Empty lanes remain visible, while left/right skips them.
- Card selection, detail entry, browser opening, search, `b/ESC`, and global `q` behave as specified.
- No Board key path invokes provider mutation or execution services.

- [ ] **Step 4: Commit any final test-only adjustments**

```bash
git add tests/e2e/dashboard-layout.test.ts
git commit -m "test(tui): cover responsive kanban board workflow"
```
