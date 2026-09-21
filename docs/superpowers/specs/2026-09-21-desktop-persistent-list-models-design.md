# Desktop Persistent List Models Design

Date: 2026-09-21

## Goal

Persist the desktop client's frequently-read list data so pages can render the last successful local model immediately while remote or system data sources synchronize in the background.

This design covers:

- Global work items and their source/associated repositories.
- Project Backlog lists.
- SSH host lists and diagnostics.

It does not add a standalone repository page. Repository data remains part of the global work-item inventory model.

## User Experience

On a first visit with no local snapshot, the page waits for its source as it does today. After the first successful load, subsequent page visits and application restarts render the persisted snapshot before starting synchronization.

Snapshots older than five minutes remain usable. The page renders them immediately and refreshes in the background. A manual refresh always waits for the real source and does not return the snapshot as a successful forced refresh.

When synchronization fails, the last successful snapshot remains visible. Existing diagnostics or page-level errors communicate the failure without replacing usable local data with an empty list.

## Architecture

### Storage Adapter

Introduce one main-process JSON snapshot adapter responsible only for filesystem behavior:

- Versioned documents.
- Schema validation supplied by each domain.
- Atomic temporary-file replacement.
- Serialized writes.
- Corrupt-file recovery that returns no snapshot rather than crashing a page.
- Storage under Electron's `app.getPath("userData")` directory.

The adapter must not contain Backlog, SSH, or work-item business rules.

### Domain Services

Each domain service owns:

- Cache-key construction.
- Snapshot schema and validation.
- Freshness policy.
- In-memory request deduplication.
- Background refresh behavior.
- Mutation invalidation or write-through behavior.

Renderer components continue to call the typed preload API and never access the filesystem.

### Synchronization

A small scheduler service runs non-overlapping synchronization jobs. The default interval is five minutes.

Global work items synchronize at application startup. Project Backlog synchronization requires a workspace and therefore synchronizes the saved/active workspace. SSH hosts synchronize at application startup because they are global to the desktop client.

Page entry also requests data through the local-first service, which handles missing or stale snapshots without creating duplicate source calls.

## Data Models

### Global Work Items and Repositories

The existing work-item inventory snapshot remains the source of persisted repository data:

- `items`
- `projects`
- item `sources`
- item `repositories`
- diagnostics and completeness
- synchronization timestamp

Provider and repository filters may project from a complete local inventory. They must not require a second remote call when the complete snapshot is available.

### Project Backlog

Snapshots are keyed by normalized:

- Absolute workspace path.
- Provider/platform selection.
- Backlog list filters.

Each entry contains the validated `BacklogItem[]` result and synchronization timestamp.

Backlog mutations invalidate affected workspace snapshots:

- Create item.
- Add or remove tag.
- Execution operations that can change provider state.
- Explicit manual refresh.

The renderer's existing short-lived cache may remain as a presentation optimization, but the main-process persistent service becomes the authoritative local model across restarts.

### SSH Hosts

The persisted SSH inventory contains:

- Validated host DTOs returned to the renderer.
- Non-secret diagnostics.
- Synchronization timestamp.

It must never persist:

- Passwords or passphrases.
- Private keys.
- Terminal input.
- Complete terminal output.
- Decrypted safe-storage values.

Host add, update, remove, trust, credential mutation, key deployment, upload, and connectivity operations invalidate or refresh the SSH inventory when they can affect displayed state.

## Failure Handling

- Invalid snapshot entries are skipped or treated as absent.
- Snapshot write failures do not fail a successful source request.
- Background synchronization failures are caught and surfaced through existing diagnostics where available.
- Partial remote inventory results do not replace a previously complete persisted snapshot unless the domain explicitly supports merging them safely.
- Concurrent reads for the same cache key share one source request.
- A late source response cannot overwrite a newer invalidation generation.

## Security

- Snapshot files use user-only permissions where supported.
- IPC sender and argument validation remains unchanged.
- Shared DTOs remain free of Electron, Node, React, DOM, and filesystem dependencies.
- SSH snapshots contain only data already exposed through the typed renderer bridge.

## Testing

### Unit Tests

- Atomic snapshot read/write and corrupt-file recovery.
- Key normalization for workspace and filters.
- Fresh, stale, missing, forced-refresh, and failed-refresh paths.
- In-flight request deduplication and invalidation generations.
- Backlog mutation invalidation.
- SSH mutation invalidation and secret exclusion.
- Repository projection from a complete work-item snapshot.
- Scheduler startup, interval execution, stop, and overlap prevention.

### E2E Tests

Use real Electron, preload, IPC, renderer, and controllable fake data-source latency.

For each covered list:

1. Start with an empty user-data directory and measure time until rows are visible.
2. Confirm the local snapshot is written.
3. Restart with the same user-data directory and measure time until rows are visible.
4. Confirm the cached render completes before the delayed source response.
5. Confirm background synchronization still invokes the source.
6. Confirm manual refresh waits for the source.
7. Confirm existing filtering and mutation flows still work.

The performance assertion compares cold and warm render times rather than requiring a machine-specific absolute duration. The warm render must complete in less than half the cold render time under the controlled delayed-source fixture.

## Rollout

Implement in this order:

1. Extract the reusable snapshot adapter from the existing work-item store behavior.
2. Migrate the work-item inventory store without changing its IPC contract.
3. Add project Backlog persistence and invalidation.
4. Add SSH inventory persistence and invalidation.
5. Add startup/background synchronization composition.
6. Add E2E performance coverage for all three list paths.

No migration is required for existing users. Missing snapshot files represent an empty local model and populate after the next successful source load.
