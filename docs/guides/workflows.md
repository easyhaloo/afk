# AFK Workflows

This guide describes the implemented work-item lifecycle. The command registry and source code are authoritative when examples differ.

## Responsibility boundary

AFK consumes provider-backed work items that already have a clear scope, acceptance criteria, and dependency relationships. Requirement clarification and task decomposition happen upstream; AFK does not create a global plan or split a request into tasks during execution.

The issue tracker is authoritative for backlog state. AFK's local manifests and runtime records provide execution identity, isolation, audit, and recovery.

## Choose the execution entry point

| Entry point | Use it for | Boundary |
|---|---|---|
| `afk` | Interactive CLI/TUI operations | Opens the terminal UI |
| `afk run` | Implementation-stage execution | Does not complete the full managed QA/merge lifecycle by itself |
| `afk execute --work-item-id <id>` | Managed execution of one work item | Validates eligibility and manifest, runs implementation and independent QA, prepares/verifies a change request, and stops at the human merge gate |
| `afk loop start` | Repeated attempts for one manifest-bound work item | Delegates attempts to `executeWorkItem`; it is not a global multi-item queue |
| `afk qa` | Standalone verification | Useful when QA needs to run independently |
| `afk observe` | Inspect runs and evidence | Read-only observation surface for runtime/audit projections |

See [Getting Started](../getting-started.md) for setup and [Architecture Overview](../architecture/overview.md) for the complete CLI surface.

## Managed lifecycle

1. **Resolve identity and eligibility.** Identify the provider-backed work item and resolve its execution manifest. Missing required identity or invalid state must not silently fall back to a different task.
2. **Prepare an isolated workspace.** Use the canonical execution root and repository checkout; do not assume the current shell directory defines the workspace.
3. **Implement.** The selected agent provider performs the implementation in the prepared execution environment.
4. **Verify independently.** QA evaluates acceptance criteria and records evidence separately from implementation claims.
5. **Prepare or verify the change request.** Publish the implementation branch and create or reconcile the provider-backed change request as applicable.
6. **Stop at the human merge gate.** AFK does not merge code automatically. The provider state is reconciled after a human performs the merge.

A successful `afk run` means the implementation stage completed; it is not equivalent to a successful `afk execute` lifecycle or a merged change.

## CLI and Desktop

The CLI and Desktop share Runtime use cases. Desktop managed execution runs in a detached Node worker, so execution can outlive the renderer window. Desktop renderer code uses validated IPC and must not import Runtime directly. The Work Items view starts or retries managed work; the Run Center projects the corresponding audited attempts.

## State, evidence, and recovery

Treat these as separate projections:

- **Provider backlog / change request:** external business state.
- **Runtime lifecycle:** current execution attempt and recovery state.
- **Run events:** append-only audit history and replay input.
- **Evidence:** classified references supporting QA, diagnosis, and reporting.

If an agent stops responding, verification cannot run, or required evidence is missing, preserve the failure and evidence. Do not infer completion from a process exit or a successful implementation-only run. Recovery and reconciliation must retain the same work-item identity.

## Skills integration

Skills provide agent-side workflows for clarification, research, PRD authoring, issue decomposition, implementation, testing, QA, handoff, and knowledge management. They do not replace AFK's runtime lifecycle or provider state. For skill responsibilities and boundaries, see the [Skills Guide](skills.md).

## Related documents

- [Full Workflow & E2E Architecture](../architecture/full-workflow-e2e-architecture.md)
- [Execution Architecture](../architecture/execution.md)
- [Observability](../architecture/observability.md)
