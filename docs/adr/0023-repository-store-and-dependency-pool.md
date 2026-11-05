# ADR-0023 — Repository store and dependency pool

- **Status:** accepted
- **Date:** 2026-11-04
- **Decision Drivers:** bounded workspace growth, shared Git objects, reproducible dependency reuse, retained failure evidence

## Context

Per-item clones duplicate repository objects and Node installations. Removing only successful first-attempt checkouts leaves failed retries and QA workspaces behind. Global package-manager store pruning cannot solve duplicated installations, and deleting an apparently idle workspace without checking ownership can destroy active work.

## Decision

1. Cache one bare repository per remote under `~/.loop-workspace/repos/<host>/<project>/bare.git`. Create detached linked worktrees at the existing manifest checkout paths, then prepare the declared working branch. Serialize bare creation, fetch, branch preparation, publication, and removal using the existing filesystem operation gate. Fetch remote refs without rewriting checked-out local branches.
2. Validate remote identity and trusted cache directories. Keep local unpublished commits and recovery stashes. Remove nested verification worktrees before their parent checkout. Keep bare caches after checkout removal. Existing independent clones remain compatible and are not automatically converted.
3. Pool Node dependencies under `~/.loop-workspace/deps/<hash>/layout/`, keyed by lockfiles, all workspace package manifests, package-manager configuration and patches, OS/architecture, and Node ABI. Capture installations after a phase, then attach matching entries before later phases. Do not introduce another installer or duplicate Maven/Go global caches.
4. Preserve real `node_modules` directories with per-entry links. Keep pnpm task/workspace state local and remap direct workspace-package links into the current checkout. Reject unsupported external or nested source links from pooling instead of publishing broken cache entries. Tracked dependency directories are protected from reclamation.
5. Pins protect referenced entries. On release, drop references and evict unpinned pools by least recent use above the default 8 GiB budget. Preserve source and diagnostic evidence after failure, while releasing regenerable managed dependencies. Successful phases remove their managed worktrees. Cleanup occurs while the caller owns the repository lease and after owned agents stop.
6. Add read-only `afk doctor` disk inventory with per-cache and workspace sizes, live-lease checks, and conservative reclaimable-byte estimates. Blocked or unknown workspace states remain retained; only confirmed inactive completed/publication workspaces count as reclaimable. Package-manager store pruning and bulk migration remain explicit operational actions.

## Consequences

New items reuse Git objects and compatible installed dependencies rather than duplicating them per execution. Dependency pools are trusted local caches; agents must treat linked package contents as installed dependencies, with mutable package-manager state kept local. Cache mutations serialize through one operation gate. If measured cache contention warrants it, capture can move to per-key gates while LRU reclamation retains global coordination.

Cache hits do not require network installation. Cold-cache runs still let the existing workflow install dependencies. Unsupported installations retain their usual behavior; they are not claimed as cache hits. Bare repositories and referenced dependency pools can exceed the nominal pool budget until their references are released. Disk estimates count logical file sizes, not deduplicated physical blocks, and are not measured production savings.

## Validation

Local Git integration tests exercise shared object storage, repository contention, unpublished-commit retention, dirty recovery, publication, QA borrowing, and repeated cleanup. Dependency tests cover manifest invalidation, workspace-link remapping, pnpm state isolation, protected pins, LRU eviction, and unsupported links. Doctor tests ensure active leases and blocked evidence prevent workspace reclamation. See [execution architecture](../architecture/execution.md) for configuration and lifecycle details.

The offline pnpm workspace integration test captures dependencies, removes the original checkout, attaches another checkout, and runs its workspace script against the second checkout's source. This verifies executable reuse and workspace-link remapping with the installed pnpm version; it does not establish compatibility with every pnpm release.

The read-only local inventory on November 4, 2026 counted 25 legacy workspace entries totaling 11,517,899,579 logical bytes. It found no deployed bare or dependency caches and conservatively estimated zero reclaimable bytes. One legacy manifest lacked the supported schema version, so doctor reported a diagnostic and exited with failure. The source change does not rewrite that evidence or migrate old clones. No production disk reduction has been measured, and package-manager store pruning remains an operator action.
