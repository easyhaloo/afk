# AFK Domain Glossary

The vocabulary for talking about the AFK workflow system. Architecture reviews
and design discussions use these terms; keep them in lockstep with the code.

## Workflow execution

- **WorkflowRunner** - Orchestrates a two-phase run (implement -> verify) for
  one issue: worktree, tmux session, goal dispatch, signal polling, auto-wrapup.
  Owns the phase loop and the handoff-budget decisions (WHEN to hand off);
  delegates handoff execution to the HandoffCoordinator.
  `packages/afk-execution/src/application/workflow-engine.ts`.

- **HandoffCoordinator** - Owns every way a context handoff resolves (auto
  relaunch, terminal, manual flip): negotiate summary, persist recovery doc,
  post issue comment, restart or terminate the session. One interface -
  `handoff(ctx, mode: 'auto' | 'terminal', reason?)` - hides the
  negotiate/persist/notify/relaunch cluster. The manual flip is an internal
  failure mode of `'auto'`. `packages/afk-execution/src/application/workflows/handoff.ts`.

- **Watchdog** - Detached process-group that fires after the hard timeout:
  kills the tmux session and appends to `watchdog.log`. It writes no signal
  file; the runner's `waitForResult()` polls the session state directly.
  Armed per phase / generation; disarmed during handoff negotiation and on
  cleanup.
  `packages/afk-execution/src/application/workflows/watchdog.ts`.

- **Signal** - The interactive agent/runner communication protocol via
  `.afk-signal.json`: `goal_complete`, `ac_result`, `handoff_ready`, `timeout`,
  `idle`. Batch agents use `ExecutionResult` instead. Context overflow is NOT a
  signal: the runner is the sole authority, polling statusline token usage
  directly. `packages/afk-infrastructure/src/io/signal.ts`.

- **TrackerProvider** - The seam over GitLab and GitHub (issues, MRs/PRs,
  labels, comments, AC parsing). `packages/afk-application/src/tracker/types.ts`.

- **LoopRunner** - Drives one manifest-bound work item to completion
  (implement -> QA -> done), then stops. It requires exactly one backlog ID,
  one work item ID and one execution manifest, and delegates the run itself
  to `executeWorkItem`. The tracker labels are the source of truth for
  whether work is eligible at all.
  `packages/afk-execution/src/application/modules/loop-runner.ts`.

## Packages

- **@afk/core** - Pure domain types and reducers, no Node/Electron/DOM
  dependencies. `packages/afk-core/`.

- **@afk/application** - Use-case layer over @afk/core: execution, inventory,
  observation, provider-inventory. `packages/afk-application/`.
