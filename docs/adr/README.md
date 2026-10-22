# AFK Architecture Decision Records

This directory holds the project's Architecture Decision Records (ADRs).
See [the ADR process guide](../../skills/afk-to-prd/references/adr-process.md)
for the workflow.

## Index

| Number | Title | Status | Date |
|--------|-------|--------|------|
| [ADR-0001-desktop](0001-desktop-deferred-and-declined-refactors.md) | Desktop 端延后与拒绝的重构 | accepted | 2026-09-21 |
| [ADR-0014](0014-interactive-and-batch-structured-output.md) | Interactive and batch structured output | accepted | 2026-08 |
| [ADR-0015](0015-typed-workflow-runtime.md) | Typed workflow runtime | accepted | 2026-08 |
| [ADR-0016](0016-run-event-audit-spine.md) | Run Event Audit Spine | accepted | 2026-08 |
| [ADR-0017](0017-capability-profiles-and-ports.md) | Capability profiles and ports | accepted | 2026-08 |
| [ADR-0018](0018-evidence-classification-and-redaction.md) | Evidence classification and redaction | accepted | 2026-08 |
| [ADR-0019](0019-desktop-run-log-viewer-projection.md) | Shared execution views and interactive tmux access | in progress | 2026-10-14 |
| [ADR-0020](0020-backlog-item-drop-singular-change-request.md) | Backlog item drop = singular change request | proposed | 2026-09-29 |

Numbering starts at 0014. Numbers 0002-0013 were never allocated in this
repository - no ADR with those numbers was ever written, so the gap is not a
deletion and nothing is reserved behind it. Renumbering the series to close
the gap would touch every cross-reference (seven source files cite ADR
numbers today), so the series keeps its current numbers.

There is no ADR for the package boundaries. The one on
`refactor/afk-package-boundaries` (0021) describes a four-package arrangement
- core, application, infrastructure, execution - while `main` has since
re-collapsed infrastructure and execution into `runtime`. Porting it as it
stands would add a stale document; the decision record for the layout that
`main` actually has has yet to be written.
