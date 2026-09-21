# Work Items Filter and Load More Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the global work-items toolbar with compact searchable filters and replace the detached load-more button with an inline list continuation control.

**Architecture:** Extend the shared `SelectMenu` only through optional presentation and local-search props so existing callers retain their current behavior. Keep filtering and batching state in `WorkItemsPage`; CSS scopes the new pill presentation and inline continuation to the work-items page.

**Tech Stack:** React 19, TypeScript, Lucide React, CSS custom properties, Vitest/react-test-renderer, Playwright Electron.

---

### Task 1: Add optional searchable filter behavior to SelectMenu

**Files:**
- Modify: `desktop-client/src/components/SelectMenu.tsx`
- Modify: `desktop-client/src/features/backlog/backlog.css`
- Test: `desktop-client/tests/select-menu.test.tsx`

- [ ] **Step 1: Write the failing component test**

Add a test that renders `SelectMenu` with `variant="filter"`, `triggerPrefix="Issue"`, and a search configuration whose pinned value is `all`. Open the menu, enter a repository substring, and assert that the pinned “全部 Issue 来源” option plus the matching repository remain while unrelated repositories disappear. Change the query to a missing value and assert that the pinned option and configured empty-state message remain.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter afk-control-electron test -- tests/select-menu.test.tsx`

Expected: FAIL because `SelectMenu` does not yet accept filter/search props or render a search input.

- [ ] **Step 3: Implement optional menu capabilities**

Extend `SelectMenuOption` with `triggerLabel?: string`. Add optional `variant`, `triggerPrefix`, and `search` props. Keep search state local, reset it when the menu closes, retain the pinned option during filtering, render a compact empty state, add `title` for truncated labels, and return focus to the trigger when Escape closes the menu. Do not change default classes or behavior when the new props are absent.

- [ ] **Step 4: Add scoped shared styles**

Add single-line ellipsis rules for trigger and option labels, a pill presentation for `.select-menu.filter-trigger`, a bounded scroll container, and styles for `.select-menu-search` and `.select-menu-empty`. Keep existing default selector dimensions unchanged.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm --filter afk-control-electron test -- tests/select-menu.test.tsx`

Expected: all `SelectMenu` tests PASS.

### Task 2: Apply the flowing filters and inline continuation to WorkItemsPage

**Files:**
- Modify: `desktop-client/src/features/work-items/WorkItemsPage.tsx`
- Modify: `desktop-client/src/features/work-items/work-items.css`
- Test: `desktop-client/tests/work-items-page.test.tsx`

- [ ] **Step 1: Write failing work-items tests**

Extend the bounded-batch test to assert that the initial continuation reads “还有 155 个” and “继续加载”, then reads “还有 105 个” after one click. Add assertions that the toolbar has the work-items-specific class, both menus use the filter variant, and the Issue menu exposes the local search input after opening.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter afk-control-electron test -- tests/work-items-page.test.tsx`

Expected: FAIL because the current toolbar uses default rectangular menus and the current button displays `显示更多（50 / 205）`.

- [ ] **Step 3: Implement the flowing filters**

Add `work-items-toolbar` to the toolbar. Configure Provider with prefix `来源`, filter appearance, and concise trigger labels. Configure project/source with prefix `Issue`, filter appearance, concise trigger labels, and local search pinned to `all`. Keep the existing platform/project filtering and 50-item reset behavior unchanged.

- [ ] **Step 4: Implement the inline continuation**

Compute `remainingItems = Math.max(0, visibleItems.length - visibleLimit)`. Replace the standalone button with a `work-items-load-more` separator containing “还有 N 个” and a button labelled `显示更多工作项` whose visible action is “继续加载” plus a downward icon. Preserve the existing `visibleLimit + pageSize` update and remove the control when no items remain.

- [ ] **Step 5: Add responsive work-items styles**

Allow the search field to grow, prevent filter text wrapping, give the Issue filter a wider but bounded trigger, and wrap both pills below the search field on narrow screens. Style the continuation with two quiet divider lines and a large enough button hit area without restoring a boxed primary button.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm --filter afk-control-electron test -- tests/select-menu.test.tsx tests/work-items-page.test.tsx`

Expected: all focused tests PASS.

### Task 3: Protect the desktop interaction in Electron E2E

**Files:**
- Modify: `desktop-client/tests/e2e/work-items-global.spec.ts`
- Modify only if needed for fixture volume: `desktop-client/tests/e2e/_helpers/launch.ts`

- [ ] **Step 1: Add E2E assertions**

Verify the toolbar triggers remain single-line at the standard viewport, the Issue source menu has a bounded scrollable options area, and source filtering still selects `acme/web`. If the shared fixture contains more than 50 items, also click the continuation and verify the row count increases; otherwise keep batch-count behavior covered by the component test.

- [ ] **Step 2: Run the focused Electron E2E**

Run: `AFK_E2E_PORT=5186 pnpm --filter afk-control-electron build:main && AFK_E2E_PORT=5186 pnpm --filter afk-control-electron e2e -- tests/e2e/work-items-global.spec.ts`

Expected: all global work-items E2E cases PASS.

### Task 4: Final verification

**Files:**
- Verify all modified files above.

- [ ] **Step 1: Run desktop unit tests**

Run: `pnpm --filter afk-control-electron test`

Expected: all desktop unit tests PASS.

- [ ] **Step 2: Run typecheck and production build**

Run: `pnpm --filter afk-control-electron typecheck && pnpm --filter afk-control-electron build`

Expected: both commands exit 0.

- [ ] **Step 3: Run diff validation**

Run: `git diff --check`

Expected: no whitespace errors.
