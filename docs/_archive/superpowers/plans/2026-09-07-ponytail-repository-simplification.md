# Ponytail Repository Simplification Plan

**Goal:** Remove repository code and dependencies that have no production callers while preserving AFK CLI and desktop behavior.

**Constraints:** Keep the current architecture boundaries, do not change public behavior, and verify the root CLI and `desktop-client` independently.

## Acceptance Criteria

- [x] Root `package.json` describes AFK and matches the tracked AFK lockfile.
- [x] Zero-reference commands, views, compatibility barrels, duplicate types, and dormant subsystems are removed.
- [x] Desktop workflow verification uses maintained Playwright coverage instead of unreferenced CDP scripts.
- [x] Fixed board views and loading phases use static data instead of singleton registries.
- [x] Module configuration uses the existing YAML parser instead of a line parser.
- [x] Root and desktop typecheck/tests/builds pass; the architecture guard reports the same four pre-existing violations recorded at baseline.

## Tasks

### 1. Establish the baseline

- Run root TypeScript, Vitest, and architecture checks directly because the current manifest has no AFK scripts.
- Run desktop tests and build.

### 2. Restore the root package manifest

- Restore AFK package metadata, scripts, dependencies, and build settings from the tracked lockfile and repository history.
- Verify package/lock consistency and root scripts.

### 3. Delete proven dead code

- Remove unregistered `escalate` and `worktree` commands.
- Remove zero-reference board views and the unused `AgentExecutionService` experiment.
- Remove duplicate GitLab/tmux/backlog types and unused barrel files.
- Remove the unused TUI plugin/core/stats subsystem, keeping the notification type beside its only caller.
- Remove dormant desktop i18n code and tests.

### 4. Replace speculative registries

- Replace the fixed view registry with a typed static set.
- Replace the fixed loading phase registry with a static descriptor list.
- Keep existing navigation and loading behavior covered by tests.

### 5. Consolidate workflow verification and module loading

- Replace unreferenced CDP scripts with focused Playwright workflow coverage.
- Simplify module loading and parse `.afk/config.yml` with `js-yaml`.
- Remove duplicated workflow-runner documentation.

### 6. Verify the repository

- Run root typecheck, tests, build, and architecture checks.
- Run desktop typecheck, tests, build, and E2E tests that do not require unavailable external services.
- Confirm `git diff --check` and review the final deletion totals.

## Verification

- Root: `pnpm typecheck` and `pnpm test` passed with 560 tests passing and 3 skipped; the test prehook completed the production build.
- Desktop: `pnpm test` passed with 341 tests; `pnpm build` passed.
- Desktop E2E: `AFK_E2E_PORT=5175 pnpm e2e` passed all 16 Electron tests.
- Architecture guard: unchanged baseline of four violations in resource registry layering and generic record usage; no new violation was introduced.
