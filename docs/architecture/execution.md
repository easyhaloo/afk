# AFK Execution Architecture

This document describes the **current implementation**, not an aspirational multi-agent execution blueprint. For the system boundary and sources of truth, see [Architecture Overview](overview.md); for the complete execution and evidence path, see [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md).

## System boundary

AFK executes provider-backed work items that already exist and have been decomposed upstream. It does not act as a global planner or split work into tasks. The external issue tracker remains authoritative for backlog state; local manifests, journals, run events, and evidence support execution and audit.

## Workspace packages

| Package / application | Responsibility |
|---|---|
| `@afk/core` (`packages/core`) | Pure domain models, events, reducers, policies, and ports |
| `@afk/application` (`packages/application`) | Shared use cases, inventory, and execution queries |
| `@afk/runtime` (`packages/runtime`) | Provider integrations, backlog operations, workflow execution, agent/sandbox adapters, Git, tmux, and persistence |
| `@afk/workflow-graph` (`packages/workflow-graph`) | Pure workflow graph representation, projection, layout, routing, and validation |
| CLI/TUI (`apps/cli`) | User-facing command surface and terminal UI |
| Desktop (`apps/desktop`) | Electron main/preload and React renderer; uses validated IPC and a detached Runtime worker for managed execution |

Applications consume shared packages through declared exports. Shared packages must not depend on applications. Desktop renderer code must not access Node Runtime directly; Node operations stay behind the main process. Package and import-boundary checks enforce these constraints.

## Execution entry points

- `afk`: open the interactive TUI.
- `afk run`: run the implementation stage for a work item.
- `afk execute --work-item-id <id>`: execute the managed lifecycle, including eligibility and manifest checks, implementation, independent QA, change-request handling, and the human-controlled merge gate.
- `afk loop start`: repeatedly attempt one manifest-bound work item by delegating to the same managed execution path. It is not a global multi-item scheduler.
- `afk qa`: run standalone QA where appropriate.
- `afk observe`: inspect executions and their audit/evidence projections.

The command registry in `apps/cli/src/command-registry.ts` is the source of truth for the complete CLI surface. Do not infer supported commands from old examples or plans.

## Data and workspace boundaries

- AFK configuration and system data live under `~/.afk/`.
- Execution workspaces live under `~/.loop-workspace/`.
- Per-workspace manifests, launch receipts, sessions, diagnostic runs, and execution journals are stored under the hashed workspace area in `~/.afk/workspaces/`.
- Repository checkouts live under the canonical execution workspace; the caller's current directory does not redefine the canonical execution root.
- Agent completion signals and QA artifact manifests are execution-local protocol files, not general configuration or lifecycle-state stores.

These paths describe distinct storage responsibilities. Consult the current implementation and [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md) for detailed resolution behavior; do not infer exact runtime paths from this summary.

## Managed lifecycle

The managed execution path validates the work item and its execution manifest, runs implementation, records branch and run evidence, performs independent QA, and prepares or verifies the provider-backed change request. A successful run does not merge code. The final merge is human-controlled; the work item reaches its terminal completed state only after merge and reconciliation.

The provider backlog, runtime state, run-event audit trail, and evidence are separate projections with different authority:

- Provider state is authoritative for backlog and change-request status.
- Runtime state records the execution attempt and its lifecycle.
- Append-only run events support audit and replay.
- Evidence references and classifications support QA, diagnostics, and redaction policy.

## Failure and recovery

Execution must fail closed when required identity, manifest, claim, or verification evidence is missing or invalid. Recovery and reconciliation use the existing work-item identity and recorded state; reconciliation is not a shortcut for creating a new execution manifest. If the agent stops responding or verification cannot run, the system must preserve evidence and surface a recoverable state rather than treating the task as complete.

## Related documents

- [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md)
- [Observability and Evidence](observability.md)
- [Architecture decision records](../adr/README.md)
