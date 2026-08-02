# AFK Observability Survey

**Date:** 2026-08-02
**Scope:** `src/` only — runtime/logging/errors/workflow-state/metrics
**Method:** Four parallel Explore agents over logger, error handling,
workflow state, and metrics/health dimensions. Findings cross-referenced
with primary sources.

---

## TL;DR

AFK has **strong local observability primitives** (structured pino JSONL
with day-rotation and redaction; signal-file protocol with atomic writes
and watchdog; tracker-label state machine; loop/scheduler status files)
but **zero external telemetry** (no APM, no metrics export, no health
endpoint). Coverage gaps are concentrated in the `commands/*` layer,
which bypasses pino and uses `console.*` directly — meaning
`afk issue`, `afk worktree`, `afk kanban`, `afk signal`, `afk debug`,
`afk tmux`, and `afk completion` are un-instrumented.

The operational posture is "a power user reading `~/.afk/logs/`" rather
than "production telemetry". A few sharp gaps: no global
`uncaughtException` handler, no versioned signal schema, no
self-healing recovery from terminal handoff, and a fully-stubbed
`StatsAggregator` that is never instantiated.

---

## 1. Logging

**Library:** pino + pino-pretty, day-rotated JSONL file
**Module:** `src/lib/core/io/logger.ts`

### What works

| Property | Value | Source |
|----------|-------|--------|
| File destination | `~/.afk/logs/afk-YYYY-MM-DD.log` | logger.ts:23 |
| Format | JSONL on disk; pretty colorized on TTY stderr | logger.ts:133–145 |
| Rotation | Date in filename; new day = new file | logger.ts:19–24 |
| Retention | 7 days, lazy-pruned on next-day open | logger.ts:26–42, 95 |
| Write guarantee | Synchronous `writeSync` (survives fast `process.exit()`) | logger.ts:64–78 |
| Redaction | `token`, `password`, `secret`, `key` + `*.{token,password,secret,key}` → `[redacted]` | logger.ts:113–119 |
| Error serializer | pino stdlib `err` (captures stack) | logger.ts:120 |
| Daemon mode | `redirectStdioToLog()` swaps console + `process.stdout/stderr` to day log | logger.ts:186–203 |
| Octokit deprecation warnings | Hijacked from stderr → file log | logger.ts:160–170 |

### Coverage

| Layer | Uses `logger` | Uses `console.*` directly |
|-------|---------------|---------------------------|
| scheduler, loop-runner, workflows, qa-runner, handoff, project-resolver | YES | NO |
| GitHub client, worktree (errors only), scheduler/loop commands (some) | PARTIAL | PARTIAL |
| cli-utils helpers (`success`/`info`/`warning`/`fail`/`detail`) | NO (only `logAndReturn` uses `logger.warn`) | YES — all of them |
| commands: tracker, worktree, kanban, signal, debug, tmux, completion | NONE | YES — all output |
| views/app TUI components | NONE | `console.warn` × 3 for fetch errors |

`redirectStdioToLog` has **one caller**: `src/commands/loop.ts:200` when
`AFK_LOOP_CHILD === '1'`. No other daemon/background path benefits from
the unified log capture.

### Gaps

- **All `commands/*.ts` use raw `console.*`** — diagnostics never reach
  the JSONL log unless a parent process happens to redirect them.
- **`handleCommandError` (cli-utils.ts:52) exits via `process.exit(1)`
  after raw `console.error`** — aborts are invisible to the log file
  when not in `redirectStdioToLog` mode.
- **Only `info`/`warn`/`error` are used** — `debug`/`trace` levels exist
  in pino but are silently suppressed under default `LOG_LEVEL=info`.
- **`LOG_DIR` is hardcoded** (`~/.afk/logs`); only `LOG_LEVEL` is
  overridable via env.
- **`src/views/app/DashboardEntry.tsx` `console.warn` × 3** — TUI fetch
  warnings never reach the file log.

---

## 2. Error Handling

### What works

| Component | Source |
|-----------|--------|
| Canonical UX: `Error:` + `Hint:` + `Context:` lines | cli-utils.ts:52–67 |
| Recovery hints via keyword-in-message matching (6 patterns: token / project / repo / not-found / auth) | cli-utils.ts:21–44 |
| Stack capture via pino `err` serializer | cli-utils.ts:78 |
| Exit code convention: `0` success / `1` general error / preserved for Commander args | index.ts:40–53, cli-utils.ts:66 |
| SIGINT/SIGTERM drain in scheduler and loop daemons | scheduler.ts:35–44, loop.ts:257–258 |

### Retry / backoff

- **Single site** — `src/lib/scheduler.ts:287–293`: `60000ms × 2^(retry-1)`
  → 60s, 120s. After maxRetries (3), task moves to `failed[]` DLQ.
  **No jitter.**
- **Poll-error pause** — `loop-runner.ts:337`: `POLL_RETRY_DELAY_MS = 5_000`
  constant after a tracker API throw. Not a retry, just a beat.

### Signal handlers

| Daemon | Source | Drain behavior |
|--------|--------|----------------|
| `scheduler start` | scheduler.ts:35–44 | `sched.stop()` clears timers, does NOT drain active tasks |
| `loop start` | loop.ts:257–258 | `runner.stop()` drains in-flight chains up to 5 min, deletes pid file |
| `qa start` | qa.ts:117–125 | **No drain** — `setInterval` not cleared, in-flight check abandoned |

### Gaps

- **No `uncaughtException` / `unhandledRejection` handler anywhere.** A
  bug that escapes its local try/catch silently crashes via Node's
  default (stderr stack + exit 1). No diagnostic capture, no cleanup.
- **No custom error classes** — all errors are plain `Error` or
  `unknown`. Callers cannot programmatically distinguish error types.
- **Binary exit codes only** (0 / 1) — no semantic codes for auth, not-
  found, internal-failure, etc.
- **`afk qa start` has no graceful shutdown** — see table above.
- **`handleCommandError` uses `console.error` directly** — bypasses pino
  serialization/correlation.
- **No retry in `LoopRunner` or `QARunner`** — failure is terminal for
  the issue (gets `mode::hitl` tag, loop moves on).

---

## 3. Workflow State

### Signal protocol

| Signal | Required fields | Source |
|--------|-----------------|--------|
| `goal_complete` | `type`, `timestamp`, `summary` + optional `sha` | schemas.ts:6 |
| `ac_result` | `type`, `timestamp` + optional `result`, `summary`, `tests_run`, `tests_passed` | schemas.ts:22 |
| `handoff_ready` | `type`, `timestamp`, `summary` | schemas.ts:36 |
| `timeout` | `type`, `timestamp` | schemas.ts:47 |
| `idle` | `type`, `timestamp` | schemas.ts:57 |

- **Discriminated union** on `type` via Zod (schemas.ts:72)
- **Atomic write**: tmp + rename (signal.ts:21–23)
- **Read tolerates ENOENT, empty, `SyntaxError`, `ZodError`** as null
  (signal.ts:29–51)
- **Polling interval** 2s default, **timeout** 5 min default
  (signal.ts:93)
- **Location**: `<worktree>/.afk-signal.json`

### State machine

**No explicit enum.** State lives in three orthogonal axes:

1. **Tracker labels (SSOT)** — `stage::{ready-for-issues,afk-in-progress,qa,done}`,
   `mode::{afk,hitl}`, `session::<name>`, `handoff::active`, `retry-count::N`
2. **Runner phases** — `done | timeout | handoff` (`workflows.ts:16–19`)
3. **Worktree marker files** — `CRASHED` / `SUCCESS` in `.afk/`

**Validation:** none. Label writes are fire-and-forget. No formal
transition validator — a buggy label-update path can silently produce
inconsistent state.

### Lifecycle hooks

`LifecycleModule` interface (lifecycle.ts:43) — four hooks:

| Hook | Failure mode | Use |
|------|--------------|-----|
| `onInit` | Throws (terminates run) | ProjectResolver chdir |
| `onBeforeAgent` | Logged + swallowed | Pre-agent setup |
| `onAfterAgent` | Logged + swallowed | Result collection |
| `onCleanup` | Logged + swallowed | Teardown |

Modules discovered from `src/lib/modules/*.ts`, activated via `--ext`,
`.afk/config.yml → workflow.modules`, or `AFK_MODULES`.

### Watchdog

- **Architecture:** detached bash process-group, `sleep N` then
  heredoc-write `timeout` signal + kill tmux session (watchdog.ts:36–47)
- **Re-arm** replaces previous (single instance per generation)
- **Disarm**: `process.kill(-pid, SIGTERM)` kills whole group
  (watchdog.ts:53–60)
- **Side-effect log**: `WATCHDOG:<iid>:<session>:<ms>` appended to
  `<logDir>/watchdog.log` on fire (watchdog.ts:45)

### Audit trail

**There is no append-only audit log.** What serves in its place:

- **Issue comments** are the de facto event log — every phase transition,
  handoff, timeout, crash posts a comment with `<!-- afk-event: ... -->`
  markers (workflows.ts:159, 272, 381; handoff.ts:247). Append-only by
  GitHub/GitLab API nature, but not machine-parseable without scraping.
- **Handoff docs** at `.afk/handoff/handoff-<iid>-<gen>.md` per
  generation (handoff.ts:224–242).
- **`watchdog.log`** — only true append-only file; internal-only.
- **`loop-status.json`** — written every event + every `statusIntervalMs`
  (default 30s) by LoopRunner (loop-runner.ts:619). Contains implement
  active ids, QA active/queue, totals, uptime, last errors.

### Resume / crash recovery

| Path | Source |
|------|--------|
| Auto-handoff on `context_high` → disarm watchdog → write handoff doc → post in-progress comment → `restartSession` clears signal + claude-status, recreates tmux, re-arms watchdog | handoff.ts:86–118 |
| Terminal handoff / manual resume → `handoff::active` label, worktree retained, user re-triggers `/afk-implement <iid>` | handoff.ts:138–152 |
| Crash → `cleanupOnFailure` posts `crashed` comment + `mode::hitl`, kills tmux, sets worktree to `failed` | workflows.ts:157–169 |
| Stale `~/.afk/loop.pid` takeover via `signal 0` probe | loop-runner.ts:585 |

### Gaps

- **No version field on signals** — schema evolution requires full
  migration. Old-scheme signal → silent "no signal" via ZodError
  swallow.
- **`idle` signal is defined but never produced or consumed** —
  dead-code in schemas.ts:57.
- **In-flight state not persisted across crashes** — per-generation
  handoff budget lost if process dies mid-run.
- **Watchdog heredoc is non-atomic at JSON level** — process kill
  between `cat` and `mv` leaves a stale `.tmp`.
- **Token-based handoff detection requires user-side statusline
  config** — silently degrades to "never triggers" if
  `~/.claude/settings.json` is not set up
  (statusline-config.ts:23).
- **No automated self-heal from terminal handoff** — human must clear
  label and re-trigger.

---

## 4. Metrics / Dashboard / Health

### External APM

**None.** No Sentry, Datadog, OpenTelemetry, Prometheus, or StatsD
integration anywhere in `src/`.

### Status commands

| Command | Shows | Source |
|---------|-------|--------|
| `afk scheduler status` | Queue depth, worker count, uptime | scheduler.ts:54–81 |
| `afk scheduler dlq` | Dead-letter queue: iid, attempts, last error | scheduler.ts:179–211 |
| `afk loop status` | pid, log path, status file path, uptime, active iids, queue, totals | loop.ts:339–374 |
| `afk debug status` | original_command, last_command, phase, run_count, verified, root_cause, last 30 output lines | debug.ts:252–273 |
| `afk kanban` | 4-column read-only kanban (Open/In-Progress/Blocked/Done) by labels | kanban.ts |
| `afk signal read` | Current signal file contents | signal.ts:103 |
| `afk signal wait` | Poll until signal arrives or timeout | signal.ts:143 |

### TUI board (`afk board`)

- **Views**: tasks / issues / board / projects (board/index.ts)
- **Refresh**: tasks + sessions loaded **once on mount** — no polling
  interval. Issues use stale-while-revalidate (disk cache + background
  network). Project detail has 60s TTL + disk cache.
- **Verdict**: snapshot with lazy background refresh, **not** an
  operational dashboard.

### StatsAggregator (inert)

- Class defined at `src/lib/stats/aggregator.ts:7–51` with `StatsProvider`
  type in `src/lib/ui/core/types.ts:15–23`. Default 60s tick.
- `View.stats?: StatsProvider` declared in interface but **never
  instantiated**. No provider registered anywhere. Infrastructure is
  stubbed out and completely unused.

### Performance instrumentation

| Site | Usage |
|------|-------|
| scheduler.ts:71,189 | `startTime = Date.now()` for uptime |
| loop-runner.ts:170,264 | `startTime = Date.now()` for uptime + `ChainContext.startedAt` |
| workflows.ts:501,505 | Hard-timeout and completion-timeout busy-wait loops |

`process.cpuUsage` and `process.memoryUsage` **never called**.

### Correlation IDs

- `iid` is the de facto correlation key (10+ sites in scheduler, 15+ in
  workflows). Logged as a structured field.
- **No `traceId` / `correlationId` / `workflowId`** propagation scheme.
- `session` is the tmux name (`afk-gh-<iid>` / `afk-gl-<iid>`), logged
  but not as a formal trace key.

### Verbosity

Single control: `LOG_LEVEL` env var (logger.ts:104). Read at startup.
No `--verbose` / `--debug` / per-call flag. TUI has a local `D`-key
debug overlay for the last 20 nav events (views/board/Dashboard.tsx:319)
— not connected to log level.

### Gaps

- **No APM SDK** — errors and traces invisible outside
  `~/.afk/logs/`.
- **`StatsAggregator` is dead code** — defined and never instantiated.
- **No runtime metrics** — no CPU/memory/event-loop lag sampling.
- **No formal trace propagation** — cross-subsystem correlation
  requires custom parsing.
- **TUI is not real-time** — no auto-refresh.
- **No HTTP health endpoint** — status commands require local shell.
- **`LOG_LEVEL` only at startup** — not runtime-reconfigurable.

---

## Cross-Cutting Gaps

These gaps recur across multiple dimensions:

1. **`commands/*` is the un-instrumented layer.** It is the entry point
   for every user-facing command but uses raw `console.*` exclusively.
   The signal/watchdog/protocol work lives in `lib/`, which IS
   instrumented — but the shell-level error UX bypasses pino.

2. **`handleCommandError` is the canonical error sink for commands, but
   it uses `console.error` directly** — so the most important error
   reporting path is invisible to the JSONL log unless
   `redirectStdioToLog` happens to be active (loop daemon only).

3. **The signal protocol is the de facto audit trail** — but issue
   comments with `<!-- afk-event: -->` markers require scraping to
   reconstruct a timeline. There is no structured event store.

4. **No global crash handler** — `uncaughtException` / `unhandledRejection`
   is Node default. In a long-running daemon, a missed try/catch loses
   the in-memory state with no diagnostic trail beyond Node's stderr.

5. **`StatsAggregator` infrastructure is built but not wired** — the
   plumbing exists; the wiring was never done. Either complete it or
   delete it.

6. **No external telemetry** — every observability signal is local
   to `~/.afk/`. There is no way to remotely monitor a running AFK
   instance without shell access.

---

## Source Inventory

Primary files surveyed (read directly):

- `src/lib/core/io/logger.ts` (204 lines)
- `src/lib/cli-utils.ts` (116 lines)
- `src/lib/core/io/signal.ts` (108 lines)
- `src/lib/schemas.ts`
- `src/lib/workflows/lifecycle.ts` (84 lines)
- `src/lib/workflows/watchdog.ts` (62 lines)
- `src/lib/workflows/handoff.ts`
- `src/lib/scheduler.ts` (excerpts)
- `src/lib/loop-runner.ts` (excerpts)
- `src/lib/stats/aggregator.ts` (52 lines)
- `src/lib/ui/core/types.ts` (excerpts)
- `src/commands/signal.ts` (196 lines)
- `src/commands/loop.ts`, `scheduler.ts`, `qa.ts`, `kanban.ts`, `debug.ts`
- `src/index.ts`
- `src/views/board/data/fetcher.ts`, `useData.ts`
- `src/views/board/board/BoardView.tsx`
- `src/views/board/views/TaskListView.tsx`, `IssueListView.tsx`,
  `ProjectListView.tsx`
- `src/views/app/DashboardEntry.tsx`

Survey methodology: four parallel Explore agents dispatched against
non-overlapping file scopes; findings cross-checked against primary
sources listed above.