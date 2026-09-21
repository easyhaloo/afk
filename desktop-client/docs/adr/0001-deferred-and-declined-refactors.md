# ADR 0001: Deferred and declined refactors

**Status**: Accepted 2026-09-21
**Context**: TypeSafe code review of PRs 1-2 (correctness/security + architecture cleanup).

## Declined (act now would be premature)

### S4 — atomic-write ceremony duplication across 4 stores
**Claim**: Same mkdir+tmp+writeFile+chmod+rename+rm-on-error pattern repeated 4x.
**Declined because**: Each instance has subtle but intentional differences:
- json-snapshot-store: simple JSON serialization
- ssh-managed-host-store + jumpserver-store: YAML serialization, fileSystem parameter for testability, post-rename chmod
- jumpserver-credential-service: safeStorage availability check inside the write path
Extracting a common helper would either lose these differences or grow the helper into a leaky abstraction. Ponytail: don't refactor for symmetry when the apparent duplication encodes real variation.

### S9 — global `app.on('web-contents-created', installNavigationGuard)`
**Claim**: Navigation guard is only attached to the main window's webContents.
**Declined because**: Codebase contains zero BrowserView / child windows today (`grep -r BrowserView` returns nothing). Adding the global hook is defense-in-depth for code paths that don't exist. Ponytail: do not pay for code that protects nothing.

### S12 — `useAsyncData` hook for race-safe IPC
**Claim**: WorkItemsPage uses hand-rolled `requestVersion.current` ref pattern.
**Declined because**: WorkItemsPage is the only page in the renderer with this race-safety need today. Extracting a hook for a single caller is speculative. If a second page needs the same pattern, refactor then.

## Deferred (will revisit when triggered)

### S2 — async mutex duplication
**Trigger**: A new store or service needs mutex-based mutation serialization beyond the 4 existing sites. Then extract `electron/lib/async-mutex.ts` for that use case.

### S6 — renderer-side `legacyIssueSource` synthesis
**Trigger**: When the inventory service gains additional shape normalizations, fold `legacyIssueSource` into the inventory service so the renderer is a dumb consumer.

### S10 — `setWindowOpenHandler` explicit `target: '_blank'`
**Trigger**: If a window.open flow ever returns a non-default target, set it explicitly. Until then, default is fine.

### S13 — hard-coded filesystem paths in services
**Trigger**: When the storage layout changes (e.g., cross-platform XDG paths, macOS bundle ID), centralize in `electron/lib/paths.ts`. Five file changes for that future refactor is acceptable.

### S14 — SSH key path error message clarity
**Trigger**: User feedback that `assertAllowedSshPath` rejects `~/.ssh` without explanation.

## TypeSafe review notes

Q3 (stale `wire format only` comment on `backlog-contract.ts`) was initially scored as `document_only` action but rejected after feeding complete file evidence (round 5c, real 0.84 → action `decline` 0.46). The comment is technically inaccurate but the cost of fixing it outweighs the marginal clarity gain.
