# SSH SCP Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe one-click SCP upload action to the SSH host details view.

**Architecture:** The renderer requests a native file selection through a fixed IPC channel, then sends the selected path to the SSH service. The service validates the host, local file, remote destination, and current host fingerprint before the command adapter executes parameterized `scp` arguments; no shell command string is built.

**Tech Stack:** Electron IPC, React, TypeScript, OpenSSH `scp`, Vitest.

---

### Task 1: Add SCP command construction

**Files:**
- Modify: `desktop-client/electron/adapters/ssh-command-adapter.ts`
- Test: `desktop-client/tests/electron/ssh-command-adapter.test.ts`

- [ ] Add a failing test proving direct targets use `-P`, `-l`-free user syntax, identity/proxy options, `--`, and a `user@host:remote` destination.
- [ ] Implement `upload(localPath, target, remotePath)` with structured and OpenSSH-alias targets.
- [ ] Run the focused adapter test.

### Task 2: Add validated service and shared IPC contract

**Files:**
- Modify: `desktop-client/shared/ssh-contract.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/security/ssh-validation.ts`
- Modify: `desktop-client/electron/services/ssh-service.ts`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`
- Test: `desktop-client/tests/electron/ssh-validation.test.ts`

- [ ] Add the upload request/result types and renderer API method.
- [ ] Add bounded validation for local and remote paths.
- [ ] Add a service method that checks the selected file, scans/trusts the host fingerprint, chooses the configured remote workspace or `~/`, and delegates to the adapter.
- [ ] Add tests for successful upload, untrusted host rejection, invalid paths, and missing local files.
- [ ] Run focused service and validation tests.

### Task 3: Wire native file selection and renderer action

**Files:**
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Modify: `desktop-client/src/features/ssh/ssh.css`
- Test: `desktop-client/tests/electron/ssh-ipc-contract.test.ts`
- Test: `desktop-client/tests/ssh-page.test.ts`

- [ ] Register a sender-guarded upload channel that opens Electron's file picker and forwards the selected path to the service.
- [ ] Expose only the typed `ssh.upload(hostId)` bridge method.
- [ ] Add a “快速上传” action enabled only for trusted, connectable hosts, with busy/error/success feedback.
- [ ] Add IPC and renderer tests for channel registration, cancellation, forwarding, and button behavior.
- [ ] Run the desktop typecheck and focused test suite.

### Task 4: Verify

- [ ] Run `pnpm --dir desktop-client typecheck`.
- [ ] Run `pnpm --dir desktop-client test -- --runInBand` or the repository-supported Vitest command.
- [ ] Review the final diff and leave unrelated working-tree changes untouched.
