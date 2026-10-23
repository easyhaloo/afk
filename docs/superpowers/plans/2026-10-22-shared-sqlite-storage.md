# Shared SQLite Storage Implementation Plan

> **For agentic workers:** Use `executing-plans` to implement the following tasks in order. Work only in the attached `shared-sqlite-storage` worktree. Do not commit or merge without a user request.

**Goal:** Share normalized inventory and authoritative SSH configuration storage between CLI and Desktop while preserving identities and existing authentication services.

**Progress:** Tasks 1–5 storage composition and legacy migration are implemented in this worktree. Final compatibility checks remain before merge.

**Architecture:** Application owns portable storage contracts and use cases. Runtime implements SQLite, migrations, paths, and imports. CLI and Desktop compose the same adapters; Desktop retains its Electron services and IPC validation.

**Tech Stack:** TypeScript, existing Node SQLite, pnpm, Vitest; no new dependencies.

## Task 1: Shared SQLite foundation

- [x] Add `packages/runtime/src/infrastructure/storage/sqlite.ts` and `paths.ts`, with tests for root resolution, account identity isolation, protected file creation, transactional schema initialization, and incompatible schema rejection.
- [x] Reuse the current SQLite loading convention from `infrastructure/runtime/resource-registry.ts`; keep SQL drivers out of Application and Core.
- [x] Run the targeted Runtime storage tests after implementing the adapter.

## Task 2: Authoritative local configuration

- [x] Add portable host/bastion types and configuration contract in `packages/application/src/local-config.ts`.
- [x] Implement the four-table configuration schema and store in `packages/runtime/src/infrastructure/storage/`, preserving managed IDs, optional fields, route distinctions, and restrictive bastion references.
- [x] Verify durable reopen, revision conflict, route validation, imports and rollback, and explicit group removal with an unrelated OpenSSH reference.

## Task 3: Normalized inventory

- [x] Add portable inventory types/ports in `packages/application/src/local-inventory.ts` and use the existing DTO structure without importing Desktop types.
- [x] Implement normalized writes, scope publications, relation assembly, FTS, bounded SQL queries, revision-bound keyset cursors, and account metadata checks in Runtime.
- [x] Verify full DTO round trips, absent versus empty arrays, partial sync preservation, stale attempts, literal Chinese/special-character search, FK rollback, and independent configuration data.

## Task 4: Application and Provider composition

- [x] Share local query and refresh orchestration through Application; Runtime supplies Provider identity resolution and concrete adapters.
- [x] Resolve namespaces from verified Provider account IDs; never derive identity from tokens or unverified legacy JSON.
- [x] Keep network I/O outside write transactions and retain diagnostics on partial/failed refreshes.

## Task 5: CLI and Desktop integration

- [x] Compose shared stores through `@afk/runtime/storage`, with a single user-level path resolver.
- [x] Preserve CLI inventory remote-read semantics and JSON output while persisting and querying normalized rows.
- [x] Replace Desktop JSON/YAML persistence adapters with shared storage, keeping platform-specific authentication and external operations in their current modules.
- [x] Keep legacy inventory isolated; import managed configuration transactionally and preserve original files. Supply the existing secure service for legacy authentication-field handling.
- [x] Align the CLI Node engine with the tested native SQLite runtime.

## Task 6: Verification and documentation

- [x] Run each changed workspace's typecheck, build and test independently, plus `pnpm architecture:check`, `pnpm docs:check`, and `git diff --check`.
- [ ] Run schema compatibility checks under both Node and Desktop Electron and add independent-process tests for shared-file publication and initialization.
- [ ] Update architecture documentation in both languages to describe implemented behavior and distinguish remaining proposals. Review the complete diff before reporting completion.

Baseline: shared package build, 15 targeted Runtime tests and all 49 Application tests pass before implementation.
