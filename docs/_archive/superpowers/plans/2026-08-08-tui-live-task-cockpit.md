# TUI Live Task Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Make the AFK TUI a live execution cockpit centered on the focused running task, with structured activity context and responsive queue behavior while preserving read-only secondary views.

**Architecture:** Keep `Header`, `Body`, and `Footer` as independent shell regions. Extend the local runtime read model with bounded `TaskActivity` records, then let a focused `TaskCockpit` compose one task summary, progress/stage context, queue, and activity stream. `AppContent` remains the state and keyboard coordinator; provider and task mutation APIs stay outside the view layer.

**Tech Stack:** React 19, Ink 7, TypeScript, node-pty PTY tests, Vitest, local filesystem runtime diagnostics.

## Execution record

Implemented and verified on 2026-08-09. Verified behavior differs from the
initial plan in three deliberate ways:

- an empty queue renders neither a `+0 queued` summary nor a reserved wide
  column; the focused task expands to the full Body width;
- missing mode/agent/sandbox values omit the entire empty context row and
  reclaim its activity height;
- compact Header verification waits for `▸ AFK`, while wide terminals retain
  `▸ AFK Dashboard`;
- Tasks poll the local projection once per second, while per-run runtime writes
  are serialized and malformed events are filtered independently;
- responsive breakpoints use terminal width, not padded Body width, and
  Footer/Help actions are selected-item capability aware.

Verification evidence:

- focused Tasks/Backlogs/Projects/Board regression: 54/54 tests passed;
- focused affected-module regression: 78/78 tests passed;
- real PTY dashboard regression: 12/12 tests passed at 80/100/120/160 columns;
- full suite: 74 files passed, 1 environment integration file skipped; 501
  tests passed, 3 skipped;
- `npm run typecheck`, `npm run build`, and `git diff --check` exited `0`;
- final 80/120/160 screenshots were inspected from `/tmp`.

The implementation remains uncommitted. Per-session commit steps below are
intentionally deferred until the user requests a commit.

---

### Task 1: Define runtime activity read models

**Files:**
- Modify: `src/types/board.ts`
- Modify: `src/lib/runtime/task-runtime.ts`
- Modify: `src/views/board/data/fetcher.ts`
- Test: `src/lib/runtime/task-runtime.test.ts`
- Test: `src/views/board/data/fetcher.test.ts`

- [ ] **Step 1: Write failing activity model tests**

Add tests that a runtime record can expose a bounded activity list with `id`, `taskRunId`, `at`, `kind`, `message`, and optional `detail`, and that `toRuntimeTask` maps it without reading tmux sessions.

- [ ] **Step 2: Run focused tests to verify the failure**

Run: `npx vitest run src/lib/runtime/task-runtime.test.ts src/views/board/data/fetcher.test.ts --reporter=dot`

Expected: FAIL because the runtime/task types and mapping do not expose activity records.

- [ ] **Step 3: Implement the provider-neutral activity shape**

Add `TaskActivityKind`, `TaskActivity`, and `activities?: TaskActivity[]` to `src/types/board.ts`. Extend the active runtime record/source with the same serializable fields and map dates to `Date` values in `toRuntimeTask`.

- [ ] **Step 4: Bound and order activities at the runtime boundary**

Keep only the newest 50 records per run, sort ascending by timestamp for display, and ignore malformed records with missing IDs, timestamps, kinds, or messages. Continue returning active task identity even when activity files are missing.

- [ ] **Step 5: Run focused tests to verify the implementation**

Run: `npx vitest run src/lib/runtime/task-runtime.test.ts src/views/board/data/fetcher.test.ts --reporter=dot`

Expected: all focused tests pass.

- [ ] **Step 6: Commit the runtime read model**

Run: `git add src/types/board.ts src/lib/runtime/task-runtime.ts src/views/board/data/fetcher.ts src/lib/runtime/task-runtime.test.ts src/views/board/data/fetcher.test.ts && git commit -m "feat(tui): expose runtime task activity"`

### Task 2: Add pure cockpit presentation helpers

**Files:**
- Create: `src/views/board/task-cockpit/model.ts`
- Create: `src/views/board/task-cockpit/model.test.ts`

- [ ] **Step 1: Write failing helper tests**

Cover queue ordering (focused task removed, active tasks first, stale tasks after), width-specific activity limits (`2`, `4`, and all visible), task phase labels, progress normalization, and display-width-safe truncation.

- [ ] **Step 2: Run the helper tests to verify failure**

Run: `npx vitest run src/views/board/task-cockpit/model.test.ts --reporter=dot`

Expected: FAIL because the cockpit model module does not exist.

- [ ] **Step 3: Implement minimal pure helpers**

Export `getTaskQueue`, `getActivityLimit`, `getTaskPhaseLabel`, `getTaskProgress`, and `truncateTaskText`. Reuse the existing `display.ts` status/mode vocabulary and visual-width behavior; do not add provider or runtime side effects.

- [ ] **Step 4: Run helper tests to verify green**

Run: `npx vitest run src/views/board/task-cockpit/model.test.ts --reporter=dot`

Expected: all helper tests pass.

- [ ] **Step 5: Commit the cockpit model**

Run: `git add src/views/board/task-cockpit/model.ts src/views/board/task-cockpit/model.test.ts && git commit -m "feat(tui): add task cockpit presentation model"`

### Task 3: Build focused TaskCockpit components

**Files:**
- Create: `src/views/board/task-cockpit/TaskCockpit.tsx`
- Create: `src/views/board/task-cockpit/TaskCockpit.test.tsx`
- Create: `src/views/board/task-cockpit/index.ts`
- Modify: `src/views/board/views/index.ts`

- [ ] **Step 1: Write failing component tests**

Render active, stale, blocked/error, and empty task states. Assert the focused task shows ID/title, state/mode/sandbox, progress, phase sequence, queue items, structured event kinds, and no tmux-only fields. Assert empty state explains that no task is currently running.

- [ ] **Step 2: Run component tests to verify failure**

Run: `npx vitest run src/views/board/task-cockpit/TaskCockpit.test.tsx --reporter=dot`

Expected: FAIL because `TaskCockpit` is not defined.

- [ ] **Step 3: Implement the cockpit layout**

Use an Ink `Box` grid with a main focused-task column and a queue column. Keep the main column as a stable two-row identity/progress block followed by phase markers and bounded activity. Use colors plus text/icons for status and mode. Use `getTaskQueue`, `getActivityLimit`, and display-width truncation helpers.

- [ ] **Step 4: Implement responsive degradation**

For `<80` columns show only the focused task and a non-zero `+N queued`; for
`80–119` show a compact non-empty queue/latest four events; for `>=120` show a
non-empty queue and full visible event context. Let the focused task use the
full Body width when the queue is empty. Do not alter Header/Footer heights.

- [ ] **Step 5: Run component tests to verify green**

Run: `npx vitest run src/views/board/task-cockpit/TaskCockpit.test.tsx --reporter=dot`

Expected: all cockpit rendering tests pass.

- [ ] **Step 6: Commit the cockpit components**

Run: `git add src/views/board/task-cockpit src/views/board/views/index.ts && git commit -m "feat(tui): render live task cockpit"`

### Task 4: Make Tasks Body use the cockpit while preserving secondary views

**Files:**
- Modify: `src/views/board/views/Body.tsx`
- Modify: `src/views/app/AppContent.tsx`
- Modify: `src/views/board/views/Footer.tsx`
- Modify: `src/views/board/views/HelpDialog.tsx`
- Test: `src/views/app/AppContent.test.tsx`
- Test: `src/views/board/views/Footer.test.tsx`
- Test: `src/views/board/views/HelpDialog.test.tsx`

- [ ] **Step 1: Write failing integration assertions**

Assert that Tasks list mode renders `TaskCockpit`, queue focus remains navigable with `↑↓`, detail and diagnostics shortcuts still work, Backlogs/Projects/Board retain their existing bodies, and Footer/Help expose `Ctrl+D` exactly once in the relevant context.

- [ ] **Step 2: Run focused integration tests to verify failure**

Run: `npx vitest run src/views/app/AppContent.test.tsx src/views/board/views/Footer.test.tsx src/views/board/views/HelpDialog.test.tsx --reporter=dot`

Expected: FAIL because Tasks still render the flat `TaskListView` and help text lacks the cockpit semantics.

- [ ] **Step 3: Route Tasks through TaskCockpit**

Pass the filtered task collection, selected index, viewport dimensions, and the existing detail/open callbacks through `Body`. Keep `DetailScreen` as the destination for `Enter`; do not make the cockpit writeable.

- [ ] **Step 4: Update shell shortcuts and empty state**

Keep only context-valid commands in Footer and Help. Add `Ctrl+D`, structured activity wording, and a concise empty runtime state without duplicating the search prompt.

- [ ] **Step 5: Run focused integration tests to verify green**

Run: `npx vitest run src/views/app/AppContent.test.tsx src/views/board/views/Footer.test.tsx src/views/board/views/HelpDialog.test.tsx --reporter=dot`

Expected: all focused integration tests pass.

- [ ] **Step 6: Commit Tasks cockpit integration**

Run: `git add src/views/board/views/Body.tsx src/views/app/AppContent.tsx src/views/board/views/Footer.tsx src/views/board/views/HelpDialog.tsx src/views/app/AppContent.test.tsx src/views/board/views/Footer.test.tsx src/views/board/views/HelpDialog.test.tsx && git commit -m "feat(tui): make tasks view an execution cockpit"`

### Task 5: Add PTY layout and dynamic-state regression coverage

**Files:**
- Modify: `tests/e2e/dashboard-layout.fixture.tsx`
- Modify: `tests/e2e/dashboard-layout.test.ts`
- Modify: `src/views/board/layout.test.ts`

- [ ] **Step 1: Add fixture activity and multiple active task states**

Add deterministic runtime activities to the PTY fixture. Cover live,
stale/error, empty-queue, and queue ordering variants in focused component and
model tests; retain backlog lifecycle states in the PTY fixture for Board
navigation coverage.

- [ ] **Step 2: Add failing PTY assertions**

At 80, 100, 120, and 160 columns assert the focused task cockpit, queue collapse/expansion, event categories, stable Header/Footer visibility, and no duplicate command hints. Send `Ctrl+D` and verify the debug overlay; send plain `d` and verify it does not open.

- [ ] **Step 3: Run the PTY tests to verify failure**

Run: `npx vitest run tests/e2e/dashboard-layout.test.ts --reporter=dot`

Expected: FAIL until the new Tasks cockpit is wired into Body.

- [ ] **Step 4: Implement any layout-only corrections**

Adjust only viewport calculations, display-width truncation, or fixed chrome sizing revealed by the PTY assertions. Do not change runtime/provider behavior in this task.

- [ ] **Step 5: Run PTY tests to verify green**

Run: `npx vitest run tests/e2e/dashboard-layout.test.ts --reporter=dot`

Expected: all PTY scenarios pass at every configured width.

- [ ] **Step 6: Commit regression coverage**

Run: `git add tests/e2e/dashboard-layout.fixture.tsx tests/e2e/dashboard-layout.test.ts src/views/board/layout.test.ts && git commit -m "test(tui): cover live cockpit terminal layouts"`

### Task 6: Full verification and documentation sync

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-tui-live-task-cockpit-design.md`
- Modify: `docs/superpowers/plans/2026-08-08-tui-live-task-cockpit.md`

- [ ] **Step 1: Run the complete validation suite**

Run: `npm test -- --reporter=dot`

Expected: all available test files pass; only the documented environment skips remain.

- [ ] **Step 2: Run typecheck, build, and whitespace checks**

Run: `npm run typecheck && npm run build && git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 3: Audit the read-only boundary**

Run: `rg -n "claim\(|transition\(|addTag\(|tmux|TaskCockpit|TaskActivity" src/views src/types/board.ts src/views/board/data`

Expected: TaskCockpit reads runtime projection/activity only; no provider mutation method is imported by the TUI.

- [ ] **Step 4: Sync docs with final behavior**

Update the design and plan only for verified deviations, exact keyboard labels, and environment-specific PTY skips. Do not add compatibility wrappers or a database dependency.

- [ ] **Step 5: Commit final verification docs**

Run: `git add docs/superpowers/specs/2026-08-08-tui-live-task-cockpit-design.md docs/superpowers/plans/2026-08-08-tui-live-task-cockpit.md && git commit -m "docs(tui): finalize live cockpit verification"`
