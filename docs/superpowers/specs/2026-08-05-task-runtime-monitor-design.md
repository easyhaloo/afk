# Task Runtime Monitor Design

## Goal

Make the Tasks view a read-only monitor for live AFK executions. Backlogs remain
the provider-backed, static work queue and do not serve as a proxy for local
process state.

## Runtime Model

`TaskRuntimeManager` owns a small, filesystem-backed runtime projection. Each
claimed workflow or QA execution creates one record in
`~/.afk/runtime/tasks/active/<run-id>.json`. The record contains the canonical
backlog ID, phase, sandbox and agent providers, execution mode, session,
worktree and branch paths, timestamps, and diagnostic paths.

The manager touches the heartbeat whenever a workflow reaches a material
lifecycle boundary. Terminal paths archive records under
`~/.afk/runtime/tasks/archive/` with their final outcome and diagnostic
summary. The active list never derives state from provider backlog labels,
tmux sessions, or stale loop status files. A record with no recent heartbeat
is displayed as stale so an interrupted worker stays diagnosable without being
presented as healthy.

## Lifecycle

1. `WorkflowRunner` claims a backlog, creates an implementing runtime record
   after its worktree is known, then heartbeats around agent steps.
2. A successful implementation moves its record to the verifying phase while
   it waits for loop QA. The workflow record is then terminalized as handed
   off, and `QARunner` creates its own verifying record.
3. QA updates its record around sandbox execution and terminalizes it after
   merge, block, timeout, or crash.
4. Setup failures before a worktree exists are still recorded with the
   available session/provider metadata and archived with a failure summary.

## TUI Contract

The dashboard reads `TaskRuntimeManager.listActive()` through a dedicated data
fetcher. It renders the runtime phase, sandbox mode, heartbeat, process
session (when one exists), worktree, branch, and diagnostic location. `a`
attaches only when `executionMode` is `interactive` and a session is present.
`o` opens the local diagnostics path through the system opener. Backlogs keep
their provider URL action unchanged.

## Failure Handling

Runtime persistence uses temp-file plus rename writes. A read skips malformed
records rather than breaking the dashboard. Runtime diagnostic writes are
best-effort: execution correctness and backlog terminal routing do not depend
on them. The active list labels a heartbeat older than five minutes `stale`;
it does not silently drop it.

## Non-goals

This change adds no database, broker, new backlog state, or provider API. It
does not recover an interrupted process, and it does not treat tmux as a
source of truth.
