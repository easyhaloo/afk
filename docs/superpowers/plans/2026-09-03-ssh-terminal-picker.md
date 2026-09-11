# SSH Terminal Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate built-in/external SSH actions with a terminal selector supporting six terminal targets.

**Architecture:** Keep the renderer free of Electron details. Add a shared terminal ID type, validate it in the preload/main IPC boundary, and route external launches through a deterministic adapter. The SSH details view owns the selected terminal and dispatches either the existing PTY connection or the explicit external terminal request.

**Tech Stack:** TypeScript, Electron IPC, React, Vitest, macOS AppleScript and terminal CLIs.

---

### Task 1: Define the terminal contract

**Files:**
- Modify: `desktop-client/shared/ssh-contract.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Test: `desktop-client/tests/electron/ssh-ipc-contract.test.ts`

- [ ] Add `SshTerminalId = "builtin" | "iterm2" | "warp" | "ghostty" | "cmux" | "terminal"` to the shared contract.
- [ ] Change `ssh.openExternal` to accept `(hostId, terminalId)` and return the selected terminal result.
- [ ] Keep the existing `ssh.connect(hostId)` API for built-in PTY sessions.
- [ ] Add handler-boundary tests for every legal terminal ID and rejection of unknown IDs.
- [ ] Update preload invocation to send both the host ID and terminal ID.

### Task 2: Implement explicit external terminal launchers

**Files:**
- Modify: `desktop-client/electron/adapters/external-terminal-adapter.ts`
- Modify: `desktop-client/electron/services/ssh-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Test: `desktop-client/tests/electron/external-terminal-adapter.test.ts`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`

- [ ] Expand the adapter terminal union and application metadata for iTerm2, Warp, Ghostty, cmux, and Terminal.app.
- [ ] Change `open(alias)` to `open(alias, terminalId)` and reject non-macOS or missing applications without fallback.
- [ ] Use the existing AppleScript flow for iTerm2 and Terminal.app, a safe command-entry AppleScript for Warp, Ghostty's `open -na ... --args -e` invocation, and cmux's `new-workspace --command` CLI invocation.
- [ ] Preserve alias safety by passing it as an argv value or shell-quoting it before embedding it in a terminal command.
- [ ] Validate the terminal ID in `registerIpcHandlers` before calling the service.
- [ ] Forward the explicit terminal from `ssh-service.openExternal` and return the selected label.

### Task 3: Merge the SSH page actions

**Files:**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Modify: `desktop-client/src/features/ssh/ssh.css`
- Test: `desktop-client/tests/ssh-page.test.ts`

- [ ] Replace the two terminal buttons in `SshDetails` with a controlled `<select>` and one “连接” button.
- [ ] Default the selector to `builtin`; keep the selection in the page state while switching hosts.
- [ ] Dispatch `ssh.connect` for `builtin` and `ssh.openExternal(hostId, terminalId)` for external IDs.
- [ ] Show terminal-specific busy and success labels, and keep external failures from invoking `onSession`.
- [ ] Test rendering, built-in dispatch, each external terminal ID, and the trust/status gate.

### Task 4: Verify the desktop package

**Files:**
- No source changes.

- [ ] Run `pnpm vitest run --config vitest.config.ts tests/electron/external-terminal-adapter.test.ts tests/electron/ssh-service.test.ts tests/electron/ssh-ipc-contract.test.ts tests/ssh-page.test.ts`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm typecheck && pnpm build:main`.
- [ ] Confirm the built preload and handler contain the same terminal IPC arguments.
