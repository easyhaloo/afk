# AFK Domain Glossary

The vocabulary for talking about the AFK workflow system. Architecture reviews
(`/improve-codebase-architecture`) and design discussions use these terms; keep
them in lockstep with the code.

## Workflow execution

- **WorkflowRunner** - Orchestrates a two-phase run (implement -> verify) for
  one issue: worktree, tmux session, goal dispatch, signal polling, auto-wrapup.
  Owns the phase loop and the handoff-budget decisions (WHEN to hand off);
  delegates handoff execution to the HandoffCoordinator.
  `src/lib/workflows.ts`.

- **HandoffCoordinator** - Owns every way a context handoff resolves (auto
  relaunch, terminal, manual flip): negotiate summary, persist recovery doc,
  post issue comment, restart or terminate the session. One interface -
  `handoff(ctx, mode: 'auto' | 'terminal', reason?)` - hides the
  negotiate/persist/notify/relaunch cluster. The manual flip is an internal
  failure mode of `'auto'`. `src/lib/workflows/handoff.ts`.

- **Watchdog** - Detached process-group that fires after the hard timeout:
  writes a timeout signal to `.afk-signal.json`, then kills the tmux session.
  Armed per phase / generation; disarmed during handoff negotiation and on
  cleanup. `src/lib/workflows/watchdog.ts`.

- **Signal** - The agent/runner communication protocol via `.afk-signal.json`:
  `goal_complete`, `ac_result`, `handoff_ready`, `timeout`, `idle`. Context
  overflow is NOT a signal - the runner is the sole authority, polling
  statusline token usage directly.

- **TrackerProvider** - The seam over GitLab and GitHub (issues, MRs/PRs,
  labels, comments, AC parsing). `src/lib/core/tracker/types.ts`.

- **LoopRunner** - Drives the full pipeline (implement -> QA -> done) for every
  `stage::ready-for-issues` issue, continuously. Two pools (N parallel
  WorkflowRunners, one serial QARunner) with tracker labels as source of truth.
  `src/lib/loop-runner.ts`.
