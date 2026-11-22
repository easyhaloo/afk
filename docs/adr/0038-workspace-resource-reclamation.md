# ADR-0038 — Workspace resource reclamation

- **Status:** accepted
- **Date:** 2026-11-12
- **Decision Drivers:** leaked workspaces after abnormal run termination, observation without actuation, permanently blocked repository leases, bounded disk growth
- **Revises:** [ADR-0022](0022-execution-plan-and-repository-leases.md) decision 5 (manual-owner recovery), [ADR-0023](0023-repository-store-and-dependency-pool.md) decision 5 (cleanup as caller obligation)

## Context

Dependency capture/release and worktree removal run inside the workflow's `finally` chain (ADR-0023 decision 5). In-process exceptions are covered, but a killed process, power loss, or an orphaned runner leaves a real `node_modules` in the checkout and its pool pin behind. `attach()` skips checkouts that already contain `node_modules`, so the pool never absorbs leftovers; `pruneUnlocked` only runs inside `release()` and only evicts entries above the 8 GiB budget. A stale record keeps the entry pinned forever.

`afk doctor` (ADR-0023 decision 6) computes reclaimable bytes but nothing consumes them. Separately, `recoverRepositoryLease` only recovers owners registered as `registered-tmux`; every production caller passes `registeredTmux = false`, so after a crash the expired lease blocks all future runs on that repository until an operator intervenes.

## Decision

1. Reclaiming a workspace is a convergence property of the workspace, not an obligation of the run that created it. One idempotent function, `reclaimWorkspaces`, decides from cheap existing metadata — runtime records, execution manifests, repository leases — and acts only through the existing dependency pool, repository store, and claim gates.
2. A workspace is reclaimable when its execution directory exists, the repository leases for its manifest keys can be acquired, and no execution ownership claim remains open. An expired execution claim still blocks reclamation. Under both gates, reclamation rereads runtime records and requires at least one attributable record. Every attributable record, active or archived, must have a heartbeat older than `workspaceReclaimGrace` (default 24 hours, configurable with `AFK_WORKSPACE_RECLAIM_GRACE`).
3. Reclamation captures installable dependencies into the pool, releases the checkout, removes managed worktrees, deletes the workspace directory, and archives the attributed active records as `failed`. Blocked records and unknown runtime states prevent reclamation. Unusable records and foreign records cannot establish eligibility. Manifest validation remains required.
4. `DependencyPool` gains a public `prune()` that removes crash staging directories older than one hour and runs the existing budget-bounded LRU eviction. Unpinned entries remain cached until the budget is exceeded; the pool budget becomes configurable as `dependencyPoolBudget` (file key `dependencyPoolBudget`, env `AFK_DEPENDENCY_POOL_BUDGET`, default 8 GiB).
5. Revising ADR-0022 decision 5: a `manual`-owner repository lease whose owner PID is dead on the local host is recoverable without operator approval, provided the resource registry holds no active resource claiming that lease generation. Registered-tmux recovery, foreign-host conservatism, and the requirement to verify or kill registered sessions before stopping orphans are unchanged.
6. `afk doctor --fix` reports what was reclaimed or skipped. On its own, it inventories the remaining resources after reclamation. Diagnostics from reclamation or inventory produce exit code 1. Reclamation is never scheduled automatically in this change; operators and the doctor command are the triggers, and a future scheduler hook (ADR-0027) can call the same function.

## Consequences

Crashed runs stop leaking disk and stop blocking repositories: the next `afk doctor --fix` converges the workspace to the same state the `finally` chain would have produced. The reclamation decision is only as fresh as the runtime records and manifests; a run that dies between allocating a checkout and writing its manifest leaves resources invisible to this path — the legacy scan keeps reporting them as `unverified` and operator cleanup remains the tool for those. PID-liveness recovery trusts the single-host model ADR-0022 already assumes; multi-host deployments must keep operator recovery for manual owners. Reclamation measures bytes only for workspaces it reclaims, so `--fix` stays cheap even on large caches.

## Validation

Focused tests cover the reclaim decision (stale heartbeat, terminal records, active leases, fresh heartbeats), dependency capture into the pool during reclamation, workspace removal with runtime record termination, crash-staging cleanup, pool budget configuration, and manual-owner lease recovery with and without registered resources. The existing doctor report path and its blocked-state protections are unchanged and remain tested.
