# SSH Host Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add double-click editing for AFK-managed SSH hosts without allowing edits to system SSH configuration.

**Architecture:** Reuse the existing host modal in edit mode. Add a typed update path through the renderer bridge, IPC handler, SSH service, and config adapter; the adapter replaces one managed block atomically and the service handles validation and cache invalidation. Edit mode leaves the existing deployment credential untouched.

**Tech Stack:** Electron IPC, TypeScript, React, Vitest, filesystem-backed OpenSSH config adapter.

---

### Task 1: Add update contracts and backend seam

**Files:**
- Modify: `desktop-client/shared/ssh-contract.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Test: `desktop-client/tests/electron/ssh-ipc-contract.test.ts`

- [ ] Write failing tests for the typed update method and handler validation.
- [ ] Run the focused IPC test and verify it fails because update is absent.
- [ ] Add `SshUpdateRequest`, IPC channel, preload method, and guarded handler.
- [ ] Run the focused IPC test and verify it passes.

### Task 2: Implement managed-host update and config replacement

**Files:**
- Modify: `desktop-client/electron/adapters/ssh-config-adapter.ts`
- Modify: `desktop-client/electron/services/ssh-service.ts`
- Modify: `desktop-client/electron/security/ssh-validation.ts`
- Test: `desktop-client/tests/electron/ssh-config-adapter.test.ts`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`

- [ ] Write failing adapter tests for same-alias replacement and alias rename without duplicate blocks.
- [ ] Run the focused adapter tests and verify they fail.
- [ ] Add an adapter update method that replaces the old managed block and writes atomically.
- [ ] Write failing service tests for managed-only updates and cache invalidation.
- [ ] Add service validation and update flow without reading or mutating deployment credentials.
- [ ] Run the focused backend tests and verify they pass.

### Task 3: Add double-click edit UI

**Files:**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Modify: `desktop-client/src/features/ssh/ssh.css`
- Test: `desktop-client/tests/ssh-page.test.ts`

- [ ] Write failing page tests for double-clicking managed/system rows and submitting the edit modal.
- [ ] Run the focused page tests and verify they fail.
- [ ] Add edit state, row double-click handler, modal prefill, update submission, and selection retention.
- [ ] Keep the existing add flow unchanged and expose no edit affordance for system hosts.
- [ ] Run the focused page tests and verify they pass.

### Task 4: Verify the desktop package

**Files:**
- Verify: `desktop-client/package.json`

- [ ] Run the focused SSH tests.
- [ ] Run desktop typecheck and build commands from `desktop-client/package.json`.
- [ ] Review the diff for unrelated changes and report any pre-existing failures.
