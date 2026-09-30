# AFK Domain Glossary

The vocabulary for talking about the AFK workflow system. Architecture reviews
and design discussions use these terms; keep them in lockstep with the code.

## Workflow execution

- **WorkflowRunner** - Orchestrates a two-phase run (implement -> verify) for
  one issue: worktree, tmux session, goal dispatch, signal polling, auto-wrapup.
  Owns the phase loop and the handoff-budget decisions (WHEN to hand off);
  delegates handoff execution to the HandoffCoordinator.
  `src/application/workflow-engine.ts`.

- **HandoffCoordinator** - Owns every way a context handoff resolves (auto
  relaunch, terminal, manual flip): negotiate summary, persist recovery doc,
  post issue comment, restart or terminate the session. One interface -
  `handoff(ctx, mode: 'auto' | 'terminal', reason?)` - hides the
  negotiate/persist/notify/relaunch cluster. The manual flip is an internal
  failure mode of `'auto'`. `src/application/workflows/handoff.ts`.

- **Watchdog** - Detached process-group that fires after the hard timeout:
  writes a timeout signal, then kills the tmux session. Armed per phase /
  generation; disarmed during handoff negotiation and on cleanup.
  `src/application/workflows/watchdog.ts`.

- **Signal** - The interactive agent/runner communication protocol via
  `.afk-signal.json`: `goal_complete`, `ac_result`, `handoff_ready`, `timeout`,
  `idle`. Batch agents use `ExecutionResult` instead. Context overflow is NOT a
  signal: the runner is the sole authority, polling statusline token usage
  directly. `src/infrastructure/io/signal.ts`.

- **TrackerProvider** - The seam over GitLab and GitHub (issues, MRs/PRs,
  labels, comments, AC parsing). `src/domain/tracker/types.ts`.

- **LoopRunner** - Drives the full pipeline (implement -> QA -> done) for every
  `stage::ready-for-issues` issue, continuously. Two pools (N parallel
  WorkflowRunners, one serial QARunner) with tracker labels as source of truth.
  `src/application/modules/loop-runner.ts`.

## Packages

- **@afk/core** - Pure domain types and reducers, no Node/Electron/DOM
  dependencies. `packages/afk-core/`.

- **@afk/application** - Use-case layer over @afk/core: execution, inventory,
  observation, provider-inventory. `packages/afk-application/`.
