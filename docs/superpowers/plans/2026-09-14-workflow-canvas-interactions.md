# Workflow Canvas Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pointer-centered wheel zoom, draggable built-in workflow nodes, and one clearly differentiated add-step menu.

**Architecture:** Keep zoom math as a pure function in the workflow graph layout module. Persist custom node positions through the existing draft model while storing read-only node overrides in local React state. Replace the two indistinguishable toolbar buttons with one icon-only trigger and an accessible local menu.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Playwright Electron.

---

### Task 1: Pointer-Centered Zoom Math

**Files:**
- Modify: `desktop-client/src/features/workflows/graph/canvas-layout.ts`
- Test: `desktop-client/tests/canvas-layout.test.ts`

- [ ] Add a failing unit test proving the world coordinate under the pointer remains stable after zoom.
- [ ] Run `pnpm test run tests/canvas-layout.test.ts --config vitest.config.ts` and confirm the missing helper failure.
- [ ] Add `zoomCanvasViewportAtPoint` with 0.7–1.35 clamping.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: All-Node Dragging

**Files:**
- Modify: `desktop-client/src/main.tsx`
- Modify: `desktop-client/src/control.css`
- Test: `desktop-client/tests/e2e/workflow.spec.ts`

- [ ] Add a failing Electron test that drags the first built-in step and observes its position change.
- [ ] Add local position overrides for read-only nodes and clear them when the active template changes.
- [ ] Route custom-node movement to the workflow draft and built-in movement to local overrides.
- [ ] Apply grab/grabbing styling to every workflow node.

### Task 3: Add-Step Menu

**Files:**
- Modify: `desktop-client/src/main.tsx`
- Modify: `desktop-client/src/control.css`
- Test: `desktop-client/tests/e2e/workflow.spec.ts`

- [ ] Replace the existing two-button assertion with a failing test for one icon-only trigger and two labeled menu options.
- [ ] Add the local menu state, outside-click dismissal, Escape dismissal, and Agent/QA actions.
- [ ] Style the menu to match the approved prototype and desktop design standards.

### Task 4: Verification

**Files:**
- Verify all modified workflow files.

- [ ] Run `pnpm test -- tests/canvas-layout.test.ts`.
- [ ] Run `AFK_E2E_PORT=5175 pnpm exec playwright test tests/e2e/workflow.spec.ts --config=playwright.config.ts`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `git diff --check` and inspect the final workflow-only diff.
