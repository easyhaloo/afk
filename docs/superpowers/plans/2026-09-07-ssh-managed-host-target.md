# SSH Managed Host Target Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow AFK-managed SSH hosts to use Chinese display names while storing them outside OpenSSH config and connecting with structured real host parameters.

**Architecture:** Keep the existing OpenSSH config adapter read-only for system hosts. Add a JSON-backed AFK managed-host adapter under `~/.config/afk/ssh-hosts.json`; its stable IDs, display aliases, and connection fields are independent of OpenSSH aliases. Replace command, PTY, external-terminal, service, IPC composition, and renderer contracts so managed hosts pass a structured `SshConnectionTarget` while system hosts retain their existing OpenSSH alias behavior.

**Tech Stack:** TypeScript, Electron IPC, React, Vitest, `node:fs`, JSON persistence, argv-based OpenSSH commands.

---

### Task 1: Define the decoupled shared contracts and validation

**Files:**
- Modify: `desktop-client/shared/ssh-contract.ts`
- Modify: `desktop-client/electron/security/ssh-validation.ts`
- Test: `desktop-client/tests/electron/ssh-validation.test.ts`
- Test: `desktop-client/tests/shared/ssh-contract.test.ts`

- [ ] **Step 1: Add failing tests for Chinese display aliases and connection targets.**
  Add cases asserting `validateSshHostInput({ alias: "kg演示", hostname: "172.16.0.241" })` succeeds, empty/NUL/overlong aliases fail, and `createSshConnectionTarget()`/equivalent normalization returns hostname, port, user, identity file, and jump fields without an OpenSSH alias.
- [ ] **Step 2: Run the focused validation tests and confirm they fail for the current ASCII-only validator.**
  Run `pnpm exec vitest run --config vitest.config.ts tests/electron/ssh-validation.test.ts tests/shared/ssh-contract.test.ts` from `desktop-client`; expected failure is the Chinese alias rejection or missing target contract.
- [ ] **Step 3: Change the shared DTOs and validator minimally.**
  Add a `SshConnectionTarget` DTO with `hostname`, `port`, optional `user`, `identityFile`, `proxyJump`, `jumpHostType`, and `jumpHost`; change `SshHost.alias` and `ManagedSshHostInput.alias` to AFK display text; validate aliases as trimmed, non-empty, NUL-free text with a bounded length, while retaining strict validation for hostname, port, paths, and jump references.
- [ ] **Step 4: Run the focused tests and confirm they pass.**
  Re-run the same Vitest command; all validation and contract tests should pass.

### Task 2: Add the AFK managed-host JSON adapter

**Files:**
- Create: `desktop-client/electron/adapters/ssh-managed-host-adapter.ts`
- Modify: `desktop-client/electron/adapters/ssh-config-adapter.ts`
- Test: `desktop-client/tests/electron/ssh-managed-host-adapter.test.ts`
- Test: `desktop-client/tests/electron/ssh-config-adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests for JSON persistence.**
  Cover an empty store, adding `kg演示`, round-tripping it after a new adapter instance, stable `managed:<id>` persistence, update by ID without changing the ID, duplicate display-name rejection, removal, `0600` writes, and no writes to `~/.ssh/afk_hosts` or `~/.ssh/config`.
- [ ] **Step 2: Run the new adapter test and confirm it fails because the adapter does not exist.**
  Run `pnpm exec vitest run --config vitest.config.ts tests/electron/ssh-managed-host-adapter.test.ts`; expected failure is module/function missing.
- [ ] **Step 3: Implement the JSON adapter with atomic writes.**
  Store `{ version: 1, hosts: [...] }` at `path.join(home, ".config", "afk", "ssh-hosts.json")`; generate a cryptographically random stable ID only for new records, preserve IDs on update, return `SshHost` DTOs with `configPath: "~/.config/afk/ssh-hosts.json"`, and use a temp file plus rename with mode `0600`.
- [ ] **Step 4: Restrict the existing OpenSSH config adapter to system reads in production.**
  Preserve its parser and system-host diagnostics, but expose a `listSystemHosts()` entry point that reads only `~/.ssh/config`; leave legacy test helpers intact where needed until service composition is switched.
- [ ] **Step 5: Run both adapter test files and confirm they pass.**
  Run `pnpm exec vitest run --config vitest.config.ts tests/electron/ssh-managed-host-adapter.test.ts tests/electron/ssh-config-adapter.test.ts`.

### Task 3: Replace alias-based command and terminal APIs

**Files:**
- Modify: `desktop-client/electron/adapters/ssh-command-adapter.ts`
- Modify: `desktop-client/electron/adapters/ssh-pty-adapter.ts`
- Modify: `desktop-client/electron/adapters/external-terminal-adapter.ts`
- Modify: `desktop-client/shared/ssh-contract.ts`
- Test: `desktop-client/tests/electron/ssh-command-adapter.test.ts`
- Test: `desktop-client/tests/electron/ssh-pty-adapter.test.ts`
- Test: `desktop-client/tests/electron/external-terminal-adapter.test.ts`

- [ ] **Step 1: Add failing command-adapter tests for structured targets.**
  Assert `testBatch({ hostname: "172.16.0.241", port: 22, user: "root" })` produces `ssh -o BatchMode=yes -o ConnectTimeout=8 -p 22 -l root 172.16.0.241 true`; assert identity and ProxyJump arguments are argv values, and no `ssh -G` call is made for managed targets.
- [ ] **Step 2: Add failing PTY and external-terminal tests for structured targets.**
  Assert built-in PTY and external terminal launch receive the same target and construct argv/script values from the real host target; keep system-host alias support through a separate alias target variant if required by the existing system flow.
- [ ] **Step 3: Run the focused adapter tests and confirm they fail against alias-only signatures.**
  Run the three focused Vitest files and record the expected argument/signature failures.
- [ ] **Step 4: Implement shared target argument construction.**
  Add one pure helper in the command adapter to emit safe argv for `ssh`, use it for batch testing and deployment, change PTY `connect`/`deployKey` to accept a target plus display alias, and change external terminal `open` to accept a target plus display title. Keep all user-controlled values as separate argv elements; do not embed untrusted shell text.
- [ ] **Step 5: Run the focused adapter tests and confirm they pass.**
  Re-run the three files; all command, PTY, and external-terminal tests should pass.

### Task 4: Rewire SSH service and persistence composition

**Files:**
- Modify: `desktop-client/electron/services/ssh-service.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Modify: `desktop-client/electron/security/ssh-validation.ts`
- Test: `desktop-client/tests/electron/ssh-service.test.ts`
- Test: `desktop-client/tests/electron/ssh-ipc-contract.test.ts`

- [ ] **Step 1: Add failing service tests for managed targets.**
  Assert list merges system hosts and JSON-managed hosts, managed hosts never call `commands.resolve()` or `ssh -G`, fingerprint/test/connect/deploy use `hostname`/`port`/`user`, and credential lookup uses the real target rather than a display alias.
- [ ] **Step 2: Run the focused service and IPC tests and confirm they fail.**
  Run `pnpm exec vitest run --config vitest.config.ts tests/electron/ssh-service.test.ts tests/electron/ssh-ipc-contract.test.ts`; expected failures are missing managed adapter composition and old alias calls.
- [ ] **Step 3: Update service dependencies and target resolution.**
  Replace alias resolution for managed hosts with direct `SshConnectionTarget` construction; retain `commands.resolve(alias)` only for `source === "system"`. Use the stable managed ID for credential and cache keys, invalidate list/status caches after managed writes, and pass the structured target to PTY/external adapters.
- [ ] **Step 4: Compose system and managed adapters in IPC registration.**
  Instantiate the read-only system config adapter and JSON managed-host adapter under `~/.config/afk/ssh-hosts.json`; combine their list results and route add/update/remove only to the managed adapter while preserving system-host cleanup behavior as an explicit separate operation.
- [ ] **Step 5: Run the focused service and IPC tests and confirm they pass.**
  Re-run the two focused files and verify no managed path invokes `ssh -G`.

### Task 5: Update renderer contracts and SSH page behavior

**Files:**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Modify: `desktop-client/src/features/ssh/ssh.css`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Test: `desktop-client/tests/ssh-page.test.ts`

- [ ] **Step 1: Add failing page tests for Chinese managed hosts.**
  Assert the add form accepts `kg演示`, calls `ssh.add` with the Chinese display alias and real hostname, renders the host after refresh, and does not expose an OpenSSH alias-specific error or field.
- [ ] **Step 2: Run the focused page test and confirm it fails if the form or API still assumes alias-backed OpenSSH config.**
  Run `pnpm exec vitest run --config vitest.config.ts tests/ssh-page.test.ts`.
- [ ] **Step 3: Update the typed preload/API path and form copy.**
  Keep `alias` as the visible AFK display name, update placeholders/labels to say “显示名称”, remove any implication that it becomes an OpenSSH `Host`, and keep editing/search/selection keyed by stable `host.id`.
- [ ] **Step 4: Run the page tests and confirm they pass.**
  Re-run the focused page test file; unrelated pre-existing page failures must be recorded separately.

### Task 6: Update architecture docs and verify the desktop package

**Files:**
- Modify: `desktop-client/ARCHITECTURE.md`
- Modify: `docs/superpowers/specs/2026-09-07-ssh-managed-host-target-design.md` if implementation decisions changed
- Verify: `desktop-client/package.json`

- [ ] **Step 1: Update architecture documentation.**
  Document that managed hosts live in `~/.config/afk/ssh-hosts.json`, system hosts come from `~/.ssh/config`, and managed connections use structured real targets rather than OpenSSH aliases.
- [ ] **Step 2: Run all focused SSH tests.**
  Run `pnpm exec vitest run --config vitest.config.ts tests/electron/ssh-managed-host-adapter.test.ts tests/electron/ssh-config-adapter.test.ts tests/electron/ssh-command-adapter.test.ts tests/electron/ssh-pty-adapter.test.ts tests/electron/external-terminal-adapter.test.ts tests/electron/ssh-service.test.ts tests/electron/ssh-ipc-contract.test.ts tests/electron/ssh-validation.test.ts tests/ssh-page.test.ts`.
- [ ] **Step 3: Run typecheck and build.**
  Run `pnpm typecheck` and `pnpm build` from `desktop-client`; fix only regressions caused by this feature.
- [ ] **Step 4: Review the diff and report remaining gaps.**
  Confirm no code path writes new managed hosts to `~/.ssh/afk_hosts`, no managed path uses `ssh -G`, and no unrelated user changes were overwritten.
