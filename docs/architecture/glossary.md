# AFK Domain Glossary

The vocabulary for talking about the AFK workflow system. Architecture reviews
and design discussions use these terms; keep them in lockstep with the code.

## Workflow execution

- **WorkflowRunner** - Orchestrates a two-phase run (implement -> verify) for
  one issue: worktree, tmux session, goal dispatch, signal polling, auto-wrapup.
  Owns the phase loop and the handoff-budget decisions (WHEN to hand off);
  delegates handoff execution to the HandoffCoordinator.
  `packages/runtime/src/application/workflow-engine.ts`.

- **HandoffCoordinator** - Owns every way a context handoff resolves (auto
  relaunch, terminal, manual flip): negotiate summary, persist recovery doc,
  post issue comment, restart or terminate the session. One interface -
  `handoff(ctx, mode: 'auto' | 'terminal', reason?)` - hides the
  negotiate/persist/notify/relaunch cluster. The manual flip is an internal
  failure mode of `'auto'`. `packages/runtime/src/application/workflows/handoff.ts`.

- **Watchdog** - Detached process-group that fires after the hard timeout:
  kills the tmux session and appends to `watchdog.log`. It writes no signal
  file; the runner's `waitForResult()` polls the session state directly.
  Armed per phase / generation; disarmed during handoff negotiation and on
  cleanup.
  `packages/runtime/src/application/workflows/watchdog.ts`.

- **Signal** - The interactive agent/runner communication protocol via
  `.afk-signal.json`: `goal_complete`, `handoff_ready`, `timeout`, `idle`.
  Acceptance-criteria verification is not a separate signal kind: it is a
  `goal_complete` whose `kind` is `ac_verification`. Batch agents use `ExecutionResult` instead. Context overflow is NOT a
  signal: the runner is the sole authority, polling statusline token usage
  directly. `packages/runtime/src/infrastructure/io/signal.ts`.

- **TrackerProvider** - The seam over GitLab and GitHub (issues, MRs/PRs,
  labels, comments, AC parsing). `packages/runtime/src/domain/tracker/types.ts`.

- **LoopRunner** - Drives one manifest-bound work item to completion
  (implement -> QA -> done), then stops. It requires exactly one backlog ID,
  one work item ID and one execution manifest, and delegates the run itself
  to `executeWorkItem`. The tracker labels are the source of truth for
  whether work is eligible at all.
  `packages/runtime/src/application/modules/loop-runner.ts`.

## Packages

- **@afk/core** - Pure domain types and reducers, no Node/Electron/DOM
  dependencies. `packages/core/`.

- **@afk/application** - Use-case layer over @afk/core: execution, inventory,
  observation, provider-inventory. `packages/application/`.

- **@afk/infrastructure** - Adapters and ports implementations: git, tmux,
  observability, provider clients. `packages/runtime/`.

- **@afk/execution** - The execution runtime: agents, sandbox, workflow engine,
  sessions, and the `afk run` / `afk loop` / `afk qa` commands. It may reach
  core, application, infrastructure, and @afk/workflow-graph.
  `packages/runtime/`.

- **@afk/workflow-graph** - The native graph engine: IR projection, layout,
  routing, validation, and the `afk graph workflow` command.
  `packages/workflow-graph/`.
