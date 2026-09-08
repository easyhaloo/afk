# Backlog Detail Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a polished right-side Backlog detail drawer, safe external-browser opening, and custom filter controls.

**Architecture:** The renderer owns selection and detail loading, with a focused drawer component for presentation. A typed `desktop.openExternal` bridge routes validated HTTP(S) URLs to Electron's main process. Existing Backlog service behavior remains unchanged.

**Tech Stack:** React 19, TypeScript, Electron IPC, Vitest, React test renderer, CSS variables, lucide-react.

---

### Task 1: Add the external URL bridge

**Files:**
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/main.ts`
- Create: `desktop-client/electron/services/external-url-service.ts`
- Test: `desktop-client/tests/electron/external-url-service.test.ts`

- [ ] Write a failing service test for HTTP(S) acceptance and non-HTTP rejection.
- [ ] Run the focused Vitest test and observe the missing service failure.
- [ ] Implement the minimal validator/service and sender-guarded IPC route.
- [ ] Run the focused test and desktop typecheck.

### Task 2: Add the detail drawer

**Files:**
- Create: `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx`
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `desktop-client/src/features/backlog/backlog.css`
- Test: `desktop-client/tests/backlog-page.test.tsx`

- [ ] Write a failing component test for selecting a row, loading `backlog.show`, rendering details, and closing the drawer.
- [ ] Run the focused test and observe the missing drawer behavior.
- [ ] Implement selection state, detail loading, focus handling, and drawer presentation.
- [ ] Run the focused component tests.

### Task 3: Replace native Backlog selects

**Files:**
- Create: `desktop-client/src/components/SelectMenu.tsx`
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `desktop-client/src/features/backlog/backlog.css`
- Test: `desktop-client/tests/select-menu.test.tsx`

- [ ] Write a failing test for opening a custom listbox and selecting an option.
- [ ] Implement the controlled custom menu with keyboard and Escape support.
- [ ] Replace Provider and state `<select>` elements in Backlog.
- [ ] Run focused tests, typecheck, and the Backlog E2E suite.

### Task 4: Verify the complete change

- [ ] Confirm no native `<select>` remains in `BacklogPage.tsx`.
- [ ] Run `pnpm --dir desktop-client test -- --runInBand` or the repository-supported Vitest command.
- [ ] Run `pnpm --dir desktop-client typecheck`.
- [ ] Run the relevant Backlog Playwright specs when the Electron fixture is available.
