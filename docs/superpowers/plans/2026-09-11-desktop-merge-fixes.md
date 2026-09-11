# Desktop Merge Fixes Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current worktree. Keep the changes focused and do not commit unless explicitly requested.

**Goal:** Restore a clean desktop build, make graphite-theme selected controls readable, and prevent the repository from tracking a self-referential dependency link.

**Architecture:** Keep the workflow graph API DTOs in `shared/`, expose only the two required graph operations through the typed preload whitelist, and validate graph requests at the main-process boundary before calling `WorkflowGraphService`. Keep the graphite contrast fix in the existing theme stylesheet and treat dependency directories as ignored build/install state.

**Tech Stack:** TypeScript, Electron IPC, React, CSS custom properties, Vitest, Make.

---

### Task 1: Complete the workflow graph IPC contract

**Files:**
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/services/graph-service.ts`
- Create: `desktop-client/electron/security/graph-validation.ts`
- Create: `desktop-client/tests/electron/graph-validation.test.ts`

- [x] **Step 1: Write failing validation tests**

  Add tests for absolute workspaces, kebab-case template IDs, supported formats, and rejection of malformed requests in `graph-validation.test.ts`.

- [x] **Step 2: Run the focused test and typecheck**

  Run `cd desktop-client && pnpm test -- tests/electron/graph-validation.test.ts` and `pnpm typecheck`.

  Expected: the new test cannot import the validation functions yet, and `pnpm typecheck` reports the existing `DesktopApi.graphStatus` and `DesktopApi.graphGenerate` errors in `GraphReviewPanel.tsx`.

- [x] **Step 3: Add shared graph DTOs and channels**

  Define `WorkflowGraphFormat`, `WorkflowGraphDiagnostic`, `WorkflowGraphStatus`, `WorkflowGraphGenerateRequest`, and `WorkflowGraphGenerateResult` in `shared/ipc-contract.ts`; add `graphStatus` and `graphGenerate` to `DesktopApi` and `IPC_CHANNELS`.

- [x] **Step 4: Add typed preload bridge and main-process handlers**

  Add the two graph channel names to the preload-local whitelist and expose typed methods. Instantiate `WorkflowGraphService` in `register-handlers.ts`, validate sender and arguments with the new pure validation functions, then dispatch to `status()` and `generate()`.

- [x] **Step 5: Reuse shared types in the graph service**

  Remove duplicate local graph DTO declarations from `graph-service.ts` and import the shared types so the renderer, preload, handler, and service use the same wire contract.

- [x] **Step 6: Run focused tests and typecheck again**

  Run `cd desktop-client && pnpm test -- tests/electron/graph-validation.test.ts tests/graph-service.test.ts` and `pnpm typecheck`.

  Expected: focused tests pass and the previous `DesktopApi` type errors disappear.

### Task 2: Fix graphite selected-control contrast

**Files:**
- Modify: `desktop-client/src/control.css`
- Create: `desktop-client/tests/control-theme.test.ts`

- [x] **Step 1: Write a failing stylesheet contract test**

  Assert that graphite selected setting cards explicitly set a dark readable foreground for both the selected title and selected description text.

- [x] **Step 2: Run the focused stylesheet test**

  Run `cd desktop-client && pnpm test -- tests/control-theme.test.ts`.

  Expected: FAIL because the graphite theme currently changes the selected background but does not override the inherited light foreground.

- [x] **Step 3: Add the graphite selected-state colors**

  Add focused graphite selectors for `.setting-options button.selected`, its `b`, and its `span`, using a dark foreground that contrasts with the accent-soft selected backgrounds without changing unselected controls.

- [x] **Step 4: Run the stylesheet test and desktop tests**

  Run `cd desktop-client && pnpm test -- tests/control-theme.test.ts tests/appearance-service.test.ts`.

  Expected: all focused tests pass.

### Task 3: Remove the repository dependency-link defect

**Files:**
- Delete: `node_modules`
- Verify: `.gitignore`

- [x] **Step 1: Confirm the tracked link defect**

  Run `git ls-files -s node_modules` and `git show HEAD:node_modules`; confirm the tracked link points to `/Users/shenggangshu/llm/afk/node_modules` itself.

- [x] **Step 2: Ignore install state and remove the tracked link**

  `.gitignore` already contains `node_modules/`; remove only the tracked self-referential symlink. Do not delete the real `desktop-client/node_modules` dependency tree.

- [x] **Step 3: Verify root pnpm commands no longer hit ELOOP**

  Run `pnpm --filter afk-control-electron exec vitest --version` and confirm it exits successfully without `ELOOP`.

### Task 4: Full verification and visual recheck

**Files:**
- No additional source files.

- [x] **Step 1: Run the project make targets**

  Run `make desktop-test` and `make desktop-build` from the repository root. If `5174` is already occupied by an existing AFK dev instance, run `AFK_E2E_PORT=5175 make desktop-e2e` so the E2E suite does not terminate or reuse the existing service.

- [x] **Step 2: Inspect the visual result**

  Open the packaged/development desktop client, switch to graphite theme, and confirm selected setting text is readable; check workflow graph controls and SSH filters for unchanged placement, sizing, and click behavior.

- [x] **Step 3: Confirm repository state**

  Run `git status --short --branch` and `git diff --check`; verify only the intended source, test, documentation, and ignore-rule changes remain.
