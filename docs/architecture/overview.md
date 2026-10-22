# AFK architecture

## Workspace organization

The root is a private pnpm workspace. `apps/cli` owns the `afk` executable,
Commander commands, shell completion, and the Ink TUI. `apps/desktop` owns
Electron main/preload, IPC validation and the React renderer. Both consume
the same shared packages through declared exports:

| Package | Responsibility |
| --- | --- |
| `packages/core` (`@afk/core`) | Pure models, events, reducer, policy and ports |
| `packages/application` (`@afk/application`) | Shared use cases, inventory and execution queries; depends on Core |
| `packages/runtime` (`@afk/runtime`) | Workflow execution, backlog operations and Node adapters for providers, Git, tmux, sandbox and storage |
| `packages/workflow-graph` (`@afk/workflow-graph`) | Pure workflow graph projection, layout and validation |

Applications must not import another workspace's source by relative path.
Shared packages must not depend on applications; the workspace graph must be
acyclic. Desktop renderer code must not import `@afk/runtime`; Node access
stays behind main-process IPC. Runtime retains its existing internal layer
rules. The architecture check enforces these rules and package exports.

Desktop backlog operations and graph generation call Runtime directly.
Managed work-item execution runs the same `executeWorkItem` used by CLI in a
bundled, detached Node worker. This preserves task process isolation and
allows execution to outlive the desktop window. Desktop never looks up or calls
the AFK CLI. Stop, recovery and merge confirmation call shared Runtime directly;
execution has a single Worker path with no command override or fallback.

Each workspace owns its build, typecheck and tests. Root commands run shared
packages and CLI in dependency order, then repository contract tests. Desktop
validation runs separately with `pnpm --filter afk-control-electron typecheck`,
`build` and `test`. The CLI binary is `apps/cli/dist/index.js`; root no longer
publishes an executable or contains application source.

## Architecture guard

`pnpm architecture:check --check-packages` enforces layer direction and checks
the `packages/core` and `packages/application` roots for pure
source imports and dependency direction. The guard also
disallows generic records and legacy client-factory imports. The legacy migration is complete:
`scripts/architecture-legacy-baseline.json` records zero legacy files, imports,
and patterns. New legacy files or imports fail the check. Delete the stale
baseline record when removing an entry.

Layer direction applies to relative imports between non-test files in
`packages/runtime/src/domain`, `packages/runtime/src/application`,
`packages/runtime/src/infrastructure`, and `packages/runtime/src/shared`.
Application boundaries in `apps/cli` and `apps/desktop` are checked by the
workspace import guard. Passing `--require-packages` makes a missing package
root a failure instead of a skipped check.

## Scope and command surface

AFK executes backlog items that were already created and decomposed by an
external planner. It does not create or split work. The command registry is the
single source of truth for the supported surface:

| Command | Responsibility |
| --- | --- |
| `afk backlog init` | Provision provider metadata |
| `afk backlog adopt --id <id> --project <project> --platform github\|gitlab [--json]` | Explicitly adopt one open manual issue as ready AFK work |
| `afk backlog create <title>` | Create one provider-backed backlog item |
| `afk backlog list/show/tag` | Inspect and manage backlog records |
| `afk backlog inventory` | Inventory issues across all credential-accessible projects |
| `afk backlog interrupt` | Stop active execution and hand the backlog to an operator |
| `afk backlog retry` | Return blocked operator-owned work to autonomous rework |
| `afk backlog confirm-merge` | Merge an approved root backlog change and mark it done |
| `afk run --backlog-id <id>` | Execute one claimed item |
| `afk execute --work-item-id <id> --execution-manifest <path>` | Implement, independently verify, and publish one managed work item |
| `afk reconcile --work-item-id <id> --execution-manifest <path> --execution-id <id>` | Verify a human-merged root PR and reconcile its execution audit |
| `afk qa --backlog-id <id>` | Run QA for an item awaiting verification |
| `afk loop` | Poll one manifest-bound work item and call `executeWorkItem` |
| `afk loop start\|status\|stop` | Control the loop daemon: foreground or background start, status, and graceful stop |
| `afk observe` | Read append-only AFK run audit events as text by default, or with `--json` (`runs`, `executions`, `execution`, `timeline`, `verify`, `replay`, `explain`, `doctor`) |
| `afk observe <runId>` / `afk log <runId>` | Short forms of `afk observe execution <runId>` with the same `--watch`, `--tail`, `--root`, and `--json` options |
| `afk observe execution\|timeline <runId> [--watch] [--tail <count>]` | Show a detailed run timeline; optionally follow new events or limit the initial history |
| `afk retro run --run-id <id> --workspace <path>` | Analyze recorded evidence with the existing `/retro` skill and write `report.json` plus `report.html` |
| `afk retro show <report>` | Read a generated retro report |
| `afk graph workflow <template>` | Generate a deterministic workflow graph |
| `afk` (TUI), `afk signal`, `afk tmux`, `afk kanban`, `afk debug`, `afk isolate`, `afk completion` | Operational and local tooling |

There are no aliases for removed command groups. Provider metadata labels are
an adapter detail and never part of this CLI contract.

### Reading and following runs

```bash
afk observe runs
afk observe <runId>
afk log <runId> --watch --tail 20
afk observe execution <runId>
afk observe timeline <runId> --tail 20 --watch
afk observe execution <runId> --watch --tail 0
afk observe execution <runId> --json
```

`observe <runId>` uses `execution` as the default subcommand; existing named
subcommands still take precedence. `log <runId>` is a direct shortcut to the
same run viewer, including the same option validation and JSON contract.

Text output includes the recorded run state, phase, active step or human gate,
integrity, local time zone, elapsed time, and latest event. Workspace paths and
branches remain in the summary even when `--tail` hides their original event.
Timeline entries expand event fields, including steps, commits, change URLs,
session/transcript references, complete multiline error summaries, and QA
expected/actual criteria. Failed events without a recorded reason say so.
These are audit events, not a live agent stdout/stderr stream; unrecorded
details cannot be reconstructed. A running state without an active step is
not by itself a failure.

`--watch` polls once per second and appends new events without repeating the
history. It stays quiet without changes, displays human-review gates while
waiting, and exits after a terminal event. Ctrl-C or SIGTERM stops only the
observer. Invalid integrity stops following, marks the state untrusted, and
excludes unverified details. A replaced or shortened history requires restarting
the observer. `--tail` accepts a non-negative integer and counts complete events;
zero suppresses the initial timeline while retaining the summary.

`--json` preserves the existing single-document JSON contracts and cannot be
combined with `--watch` or `--tail`. Text redirected to a file or pipe has no
color escapes; `NO_COLOR` also disables colors in a terminal.

## Provider boundaries

`BacklogProvider` is the canonical source for item identity, title and
description, state, execution mode, parent, dependencies, business tags, and
the branch mapping. `BranchProvider` owns branch and worktree operations.
`ChangeProvider` owns change-request creation, lookup, and merge. The runner
coordinates these interfaces and never parses provider labels.

GitHub and GitLab are concrete `BacklogProvider` implementations selected by
the provider bundle. They delegate common tracker mechanics internally while
keeping platform validation and construction at the platform boundary. A
future integration such as Linear implements `BacklogProvider` directly; no
tracker-specific type is required by the runner.

The management bundle wraps a concrete provider in a claim-free facade. Its
backlog surface includes lookup, listing, metadata initialization, business
tag updates, and the state/mode updates needed by QA. It has no `claim()` at
the type or runtime boundary. The execution bundle is the only path that
exposes claiming and runnable checks.

`adopt` is an optional management/provider capability; unsupported providers
return an explicit error. The tracker adapter checks the issue's raw state and
metadata rather than inferring readiness from domain defaults. It accepts only
open issues with absent or canonical ready/afk lifecycle labels, rejects unknown,
duplicate or conflicting AFK metadata and malformed or self-referencing
parent/base/dependency IDs, and preserves business labels, relationships and the
issue body. Adoption initializes provider metadata only when labels are missing,
then adds only the missing ready/afk labels with no removals. An already ready/afk
item is a no-write success; closed, blocked, HITL and other lifecycle states are
rejected without writes. Project and platform are required, and `--json` emits
the `backlog.adopt` envelope. Execution and loop never invoke adoption implicitly.

## Work-item and execution identity

The Provider Backlog is the business source of truth. Its `BacklogItem.id` is
carried unchanged through `afk run --backlog-id <id>`, `Run.workItemId`,
`TaskRuntimeRecord.backlogId`, TUI projections, and Desktop summaries.
`runId` identifies one execution attempt and must never replace the Backlog ID.

Relationships have separate meanings: `parentId` is organizational grouping,
`dependsOn` controls scheduling, and `baseBacklogId` selects an explicit Git
execution base. Neither parent nor dependency edges implicitly select a branch.

## Backlog lifecycle

```text
ready/rework --claim--> in_progress --> verification --> merge_ready --> done
   \                         \
    \                         +--> blocked (execution mode: hitl)
     +--> blocked (conflict, failure, timeout, or expired lease)
```

An item is runnable only when it is in `ready` or `rework`, uses the `afk` execution mode,
has no child items, and all `dependsOn` items are `done`. `parentId` groups
child items; a parent itself is never runnable. Any automation failure,
conflict, timeout, or uncertain lease recovery transitions the item to
`blocked` and routes it to `hitl`.

QA FAIL persists a new rework record in the provider's issue comment/note,
supersedes any active record, and increments `ReworkRecord.attempt` from the
highest persisted attempt. QA record creation only persists evidence;
`QARunner` owns the subsequent state/mode routing. Operator retry still creates
its record and routes directly to `rework` + `afk`.

`WorkflowConfig.maxQaReworkAttempts` defaults to **3** and must be a positive
integer. Set `maxQaReworkAttempts: 3` in `.afk/config.yml` or use
`AFK_MAX_QA_REWORK_ATTEMPTS=3`; the project file takes precedence. With no prior
records, the first FAIL is attempt 1, the second FAIL is attempt 2, and both
allow `rework` + `afk`. The third FAIL persists attempt 3 and returns
`success: false` without `rework`, routing directly to `blocked` + `hitl`.
Further FAIL calls retain that record and cannot reopen automatic rework.
A limit of 1 blocks the first FAIL. Attempts include earlier resolved,
superseded, and operator records; restarting a runner does not reset them.
QA PASS can still resolve an active record. This limit is separate from
`maxRetries` (execution retries) and `maxSelfIterations` (AC corrections).
The handoff/token `BudgetManager` restores its snapshot from
`<workspace>/.afk/budgets/` per canonical work item. Handoff rounds and native
harness token usage persist across runs; session IDs are deduplicated and a
corrupt snapshot fails closed before a new agent execution starts.

The `commit.recorded` audit event links implementation and QA commits to the
real local SHA and branch. It is emitted only for a new commit; a change
request SHA is never substituted.

## Runtime and Desktop projections

Canonical runtime files under `~/.afk/runtime/tasks` own execution-attempt
status, phase, heartbeat, progress, and diagnostics. A heartbeat older than the
freshness threshold is displayed as runtime `stale`; it does not mutate the
Provider Backlog lifecycle state.

Desktop reads `.afk/work-item-runs.json` from the execution workspace located
by canonical `workItemId`. These records contain Worker launch receipts, not
Provider lifecycle state. Runtime records must explicitly name their workspace;
Desktop joins them by exact `backlogId`, execution workspace and provider.
Missing or malformed runtime data leaves the Backlog visible with an explicit
no-runtime state. There is no reader for the removed backlog run store.

## Claim boundary and local fallback

Providers may expose a native conditional claim (CAS). The execution provider
uses that operation whenever available. Otherwise it acquires a durable lease
under `${AFK_STATE_DIR:-~/.afk/state}` and, while holding it, rereads and
validates the item, performs `ready -> in_progress`, and rereads to confirm the
claim. The returned lease is heartbeated by the runner and released exactly
once by the run resource scope on success, failure, timeout, crash, or handoff.

The filesystem lease is a single-host mechanism backed by a local trusted
filesystem; it is not a multi-host consensus or crash-recovery mechanism.
Multi-host execution requires provider-native CAS (a shared filesystem alone is
not sufficient). Lease paths are
namespaced by provider, project, and backlog ID. Symlinked state paths are
rejected, stale leases fail closed by default, and expiry recovery is allowed
only after the provider durably records `blocked` with mode `hitl`.

## End-to-end flow

```mermaid
sequenceDiagram
    participant P as BacklogProvider
    participant R as WorkflowRunner
    participant B as BranchProvider
    participant A as Agent/Sandbox
    participant Q as QARunner
    participant C as ChangeProvider

    R->>P: claim(backlogId, owner)
    P-->>R: claim lease + item
    R->>B: create branch/worktree
    R->>A: execute item
    A-->>R: completion signal
    R->>C: create change request
    R->>P: transition verification
    R->>Q: verify item
    Q->>C: merge change request
    Q->>P: transition done
    R->>P: release lease (resource scope)
```

`afk loop` accepts exactly one scoped backlog ID and matching execution
manifest, and delegates to `executeWorkItem`. The former separate
implementation/QA queue is removed. The standalone QA command remains a
lower-level verification operation.

## Extension points

Plugins can register provider implementations through the plugin runtime.
Each provider supplies the complete `BacklogProvider` contract, including
parent/dependency validation, state transitions, execution mode, tags, and
claim behavior. Platform clients remain private to their provider. No
database or additional middleware is required; local state is kept in the
filesystem lease directory.

## Reliability rules

- A failed transition, conflict, timeout, or expired lease is `blocked` plus
  `hitl`; it is never silently retried as automatic work.
- Native claim is preferred; the filesystem fallback is deliberately scoped to
  a trusted local filesystem on one host.
- Lease cleanup is lifecycle-owned and idempotent.
- Backlog IDs map deterministically to branches through the provider-neutral
  branch naming function.
