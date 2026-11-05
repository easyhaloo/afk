# ADR-0022 — Execution plans and repository leases

- **Status:** accepted
- **Date:** 2026-11-04
- **Decision Drivers:** per-item baselines, consistent execution entry points, recoverable interruption, repository isolation

## Context

Implementation, standalone QA, and managed execution assembled providers separately. A process-wide target branch could become the QA baseline or publication destination for unrelated repositories. Independent work-item claims also allowed two items touching the same repository to run concurrently. An interrupted agent could outlive its claim, and dirty retries required manual recovery.

## Decision

1. Parse `Base Ref`, `Target Ref`, and optional `Source Ref` from the work item's `Base Version` section into an immutable execution plan. Persist all refs in each manifest repository. The target defaults to the base, while working-branch identity and `baseBacklogId` retain their existing meanings. Ref declarations must agree with an existing manifest before implementation or QA starts.
2. Resolve undeclared refs through repository-local configuration, repository-specific global overrides, provider defaults, and global defaults. Preserve legacy aliases without writing to the cached global configuration. A migration source is fetched and included in agent repository context.
3. Assemble providers through one function with canonical work-item identity and the cross-project backlog graph. Management providers wrap the same backlog, branches, and changes. `run` delegates to managed execution, including QA; explicit CLI runtime and execution-mode options remain effective. Default managed execution stays interactive.
4. Hold repository leases across the complete managed attempt, including the implementation/QA boundary. Nested preparation borrows the enclosing lease through async execution context. Standalone preparation acquires the same repository keys. Existing filesystem claim generations provide fencing, heartbeat persistence, operation serialization, and dead-owner recovery.
5. Interruption invalidates the work-item claim. Observed interruption or lost lease stops owned agent executions before publication or resource cleanup. Expired generations cannot renew; old release calls cannot remove a new generation. Local managed Claude tmux sessions register repository generations before launch and carry the same token in tmux. Automatic dead-owner recovery verifies registered session ownership before stopping orphans. Unknown or non-tmux ownership requires explicit operator recovery.
6. Store-owned dirty retries use a named Git stash and reapply edits after branch preparation. Keep the stash for recovery, including conflicts; retain the stricter dirty-checkout rejection for independent clones.
7. Schedule an existing PRD tree using the existing runnability policy and canonical relationships. Serialize intersecting repository sets, bound concurrency by available cores and repository count, pause launches under load, and drain active work on stop. Incomplete inventories and dependency cycles fail before dispatch. A dependency only completes after human merge and reconciliation.

The scheduler accepts runtime options for capacity, load, polling, and watching. The older exported `SchedulerConfig` remains a compatibility surface: its generation-stage label filters and notification/dashboard switches do not control execution scheduling. Dispatch uses the existing work-item runnability policy, and the workflow's `maxQaReworkAttempts` bounds retries.

## Consequences

Ref selection is a durable property of the item and manifest, so repository concurrency does not require rewriting machine-wide configuration. Repository ownership and work-item ownership remain distinct. The leases assume trusted local storage and a single host; unknown remote owners remain protected rather than being guessed dead. They do not replace distributed consensus or automatically authorize merging.

Generation checks fence AFK-controlled lifecycle operations. Agents still write directly to the filesystem, so ownership recovery also requires a confirmed dead owner and verified termination of registered tmux resources. This does not provide a filesystem-enforced write barrier for arbitrary external processes.

Legacy manifests without target/source fields still map target to base. Existing explicit provider-host routing remains authoritative, including dotted GitLab namespace paths. Operators must resolve deliberate body/manifest drift rather than silently running from a new branch.

## Validation

Focused tests cover ref parsing and validation, isolated repository overrides, provider assembly and self-hosted identity, managed run delegation, QA baseline versus publication target, claim invalidation and generation fencing, repository contention and partial rollback, dirty-workspace recovery, cross-repository concurrency, dependency ordering, overload pauses, and graceful scheduling stop. See [execution architecture](../architecture/execution.md) for the supported command surface.

On November 4, 2026, the built CLI successfully previewed `gitlab:w.src.corp.qihoo.net/fang/services/llm-wiki#27` with `schedule --max-concurrent 2 --dry-run --json`. Its 21 descendants contained one completed item; the remaining 20 were three human merge gates, five blocked items, and twelve dependency waits. No execution wave was eligible. The preview created no claims, agents, or provider mutations. Missing manifests use the item's repository for resource planning; invalid existing manifests still reject dispatch. Regression tests exercise the actual manifest reader and watched operator retries.

The read-only ownership audit found no tmux sessions and thirteen expired legacy claims, with no claims inside their TTL. A running Claude process had no verified ownership link to those claims. Historical claims and that process were preserved; the audit did not establish that deleting or terminating them was safe.
