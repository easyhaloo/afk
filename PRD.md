# PRD — Desktop Run Log Viewer

**Stage:** `stage::prd`
**Owner:** TBD
**Status:** Draft (awaiting HITL approval)
**Related ADR:** [ADR-0019](docs/adr/0019-desktop-run-log-viewer-projection.md)
**Related upstream:** [ADR-0016 — Run Event Audit Spine](docs/adr/0016-run-event-audit-spine.md)

---

## Problem Statement

The AFK desktop client (`desktop-client/`) launches work-item runs via
`afk run --backlog-id <id>` and tracks per-run state in its own run store
(`backlog-run-store.ts`, keyed by `desktop-<workItemId>-<uuid>`). It has
**no surface for the execution log itself** — neither in `BacklogDetailDrawer`
(`features/backlog/`) nor in the run-center page
(`features/run-center/runtime-presentation.ts`).

The data needed to render that surface already exists:

| Source | Location | Authority | Notes |
|---------|----------|-----------|-------|
| Unified pino day-rotated log | `~/.afk/logs/afk-YYYY-MM-DD.log` | Projection only | Mixed across all work items + commands; written via `fs.writeSync`; the `redirectStdioToLog()` daemon redirect also lands here. Per [[afk-logging-convention]]. |
| RunEvent JSONL audit spine | `~/.afk/events/<base64url(runId)>.jsonl` | **Authoritative** per ADR-0016 | Per-run, hash-chained, append-only, integrity-verifiable. CLI runId; desktop runId (`desktop-X-Y`) is not the same. Exposed via `afk observe`. |

For work item **#158** the audit spine contains the events needed to
explain the `blocked` transition (`max-iterations reached` → loop exit),
but the desktop has no way to read them.

## Users & Jobs

**Primary user:** AFK operator running work items from the desktop who
needs to debug a stuck / failed / blocked run without dropping to a
terminal.

**Jobs to be done:**

1. **When** a work item shows `state: blocked` (or `failed`, or any
   unexpected terminal state) in the work-items page, **I want to** open
   the work-item detail drawer and read the execution log **so I can**
   decide whether to retry, interrupt, or escalate.
2. **When** a run is in progress in the run-center, **I want to** see
   its live tail **so I can** observe progress without opening a
   terminal.
3. **When** I link a terminal-state incident to a Slack thread / ticket,
   **I want to** copy the run log to clipboard **so I can** paste it as
   evidence.

## User Stories

- **US1.** As an operator, when I click a work item in the work-items
  list, the detail drawer renders a "Run Log" section. The section shows
  the latest run's events as a chronological list. Events are rendered
  with `phase`, `kind`, `actor`, and `summary` columns (matching the
  shape `afk observe timeline` emits).
- **US2.** As an operator, when a run is `status: starting | in_progress`,
  the run-log section auto-tails: polls every 2 s and appends new
  events as they arrive, without page refresh.
- **US3.** As an operator, when I click "Copy log", the system copies
  the currently rendered event stream (newest-first or oldest-first,
  selectable) to clipboard as a Markdown table suitable for pasting
  into a ticket.
- **US4.** As an operator, when the run-log section is empty, it shows
  a hint pointing at `afk observe timeline --runId <id>` for manual
  diagnosis (so the feature degrades to "give me the terminal command"
  instead of "blank").

## Scope

### In scope

- Read-only viewer for the **latest** run of a given work item.
- Live tail while a run is active.
- Manual "Copy log" action.
- IPC contract surface: one new channel pair (`run-log.tail`,
  `run-log.snapshot`) consumed by the renderer.
- Renderer component: `RunLogPanel` (composable into
  `BacklogDetailDrawer` and `run-center`).
- Correlation: map work-item-id → CLI runId(s) via RunEvent
  `workItemId` field (handles desktop vs CLI runId mismatch).

### Non-goals

- Search / full-text across multiple runs (defer; current scope is
  "what just happened for this item").
- Log editing, pruning, or archival.
- Replacing `afk observe timeline` — desktop viewer is a projection of
  the same data, not a new source.
- Per-run filter syntax (level / kind); users filter via `afk observe`.
- Multi-run aggregation in a single view.

## Key Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| **D1** | Source of truth for the viewer is the **RunEvent JSONL store** (`~/.afk/events/<runId>.jsonl`), **not** the unified pino day-rotated log. | ADR-0016 already names RunEvent as the authoritative record. Pino log is a mixed, projection-level stream — it cannot answer "what happened for work item #158". Using RunEvent also gives free replay protection via the hash chain. |
| **D2** | The renderer reaches RunEvent **via `afk observe`**, not by reading JSONL files itself. | Reuses the existing CLI projection (`afk observe timeline`, `afk observe runs`) instead of duplicating event-store wiring in Electron. Same code path as terminal users, same format. |
| **D3** | Work-item ↔ run correlation is via the **`workItemId` field on every RunEvent** (not runId). | The desktop's runId (`desktop-<workItemId>-<uuid>`) and the CLI's runId are not the same. The event store is keyed by CLI runId. `workItemId` is the only stable cross-system identifier. |
| **D4** | Live tail = **pull-poll every 2 s**, not a push channel. | Electron IPC + 2 s poll is sufficient (events are append-only; the renderer is not on a hot path). Avoids WebSocket / IPC push plumbing for a feature whose value is "occasional inspection", not real-time monitoring. |
| **D5** | Renderer never sees the run store root path directly; all access goes through a **typed IPC service** (`run-log-service`) that runs `afk observe` and validates JSON envelopes. | Matches the existing pattern in `desktop-client/electron/services/` (`backlog-service`, `jumpserver-service`); keeps file-system and CLI access in the main process. |
| **D6** | ADR-0019 records the projection choice; this PRD is the only artifact that mentions product framing. | Avoid two documents arguing the same point; ADR for the irreversible observability decision, PRD for the user-visible surface.

Full ADR: [docs/adr/0019-desktop-run-log-viewer-projection.md](docs/adr/0019-desktop-run-log-viewer-projection.md).

## Architecture Decisions

| ADR | Decision | Status | PRD Section |
|-----|----------|--------|-------------|
| [ADR-0016](docs/adr/0016-run-event-audit-spine.md) | RunEvent is the authoritative run record | accepted | D1 |
| [ADR-0019](docs/adr/0019-desktop-run-log-viewer-projection.md) | Desktop log viewer projects from RunEvent via `afk observe` | proposed | D1, D2, D3 |

## Bounded Contexts Touched

| Context | Module | Touch |
|---------|--------|-------|
| Run audit spine | `src/core/events.ts`, `src/infrastructure/observability/jsonl-event-store.ts` | none (read-only consumer) |
| CLI projection | `src/cli/commands/observe.ts` (`runs`, `timeline`) | none (already exposes needed subcommands) |
| Electron IPC | `desktop-client/shared/ipc-contract.ts`, `desktop-client/electron/ipc/register-handlers.ts` | add 2 handlers |
| Electron service | `desktop-client/electron/services/` | add `run-log-service.ts` |
| Renderer feature | `desktop-client/src/features/run-center/`, `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx` | embed `RunLogPanel` |

## Open Risks

- **R1 — No approved alignment record.** `CONTEXT.md` at repo root is the
  AFK domain glossary (WorkflowRunner / HandoffCoordinator / Watchdog
  / etc.), **not** a feature-level alignment record. Per the
  `afk-to-prd` skill's anti-patterns, this PRD does not invent user
  stories absent from alignment — the four user stories above were
  distilled from a single observed incident (work item #158 `blocked`
  + missing log view). **Owner action:** produce an alignment record
  via `afk-research` before decomposition, or accept these four
  stories as the bounded scope.
- **R2 — Publication path is broken in the current CLI.** The skill
  spec references `afk gitlab issue-create` and `afk gitlab add-label`,
  but neither exists in the installed `afk` binary. The actual
  publication primitives are `afk backlog create` (no `--label` flag)
  and `afk backlog tag add` (no `stage::prd` mapping). Owner action:
  publish manually via GitLab UI, or extend the CLI to expose label
  management.
- **R3 — Correlation depends on every RunEvent carrying `workItemId`.**
  Spot-check confirms the field is present on `RunEvent.context`
  (`src/core/events.ts:9`). If any future emitter skips it, the
  viewer's "latest run for this item" lookup silently returns nothing.
  Owner action: add a regression test in `src/observability/` that
  asserts every append sets `workItemId`.
- **R4 — Pull-poll may miss late events that emit between polls.**
  Acceptable for the user-stated value (occasional inspection), but
  flagged because ADR-0019 commits us to pull not push. Upgrade path:
  watch `~/.afk/events/` with `fs.watch` and stream deltas via IPC if
  a real-time requirement emerges.
- **R5 — Renderer exposes `afk observe` output verbatim.** If
  `afk observe timeline` ever emits sensitive fields (tokens,
  internal paths) the viewer will too. Pair with ADR-0018 evidence
  redaction when implementing.

## Step 3–5 Status

- Step 3 (publish): **blocked by R2.** Cannot issue the GitLab issue
  via CLI. Owner must publish manually or extend the CLI.
- Step 4 (label): same blocker; `stage::prd` is not yet addressable
  from the CLI.
- Step 5 (HITL gate): pending — this PRD is currently a draft, awaiting
  the owner's approval to proceed to issue decomposition.