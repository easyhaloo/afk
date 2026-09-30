# ADR-0019: Desktop Run Log Viewer Projects from RunEvent via `afk observe`

**Status:** proposed

## Context

The AFK desktop client (`desktop-client/`) launches work-item runs via
`afk run --backlog-id <id>` and tracks run state in its own run store
(`backlog-run-store.ts`). It currently has no surface for the
execution log itself.

Three candidate sources exist for the viewer:

1. **Unified pino day-rotated log** —
   `~/.afk/logs/afk-YYYY-MM-DD.log`. Mixed across all work items, all
   commands, the daemon stdio redirect, and ad-hoc console output.
   This is a projection — see [[afk-logging-convention]].
2. **RunEvent JSONL audit spine** —
   `~/.afk/events/<base64url(runId)>.jsonl`. Per-run, append-only,
   hash-chained, integrity-verifiable. Already named **authoritative**
   by [ADR-0016](0016-run-event-audit-spine.md). Exposed via
   `afk observe runs` / `afk observe timeline`.
3. **Desktop run store** (`backlog-run-store.ts`) — holds only
   `start | status | phase | progress | branch | worktree |
   diagnosticPath | heartbeatAt`. No log content.

The desktop runId format (`desktop-<workItemId>-<uuid>`) is **not** the
same as the CLI runId used as the event-store key. Work-item ↔ CLI
correlation exists only via the `workItemId` field on every
`RunEvent.context` (`packages/afk-core/src/events.ts:9`).

The viewer must pick exactly one source so the projection does not
fragment, and must solve runId correlation.

## Decision

The desktop run-log viewer **reads from the RunEvent JSONL store via
`afk observe`** and never reads the unified pino log.

Concretely:

1. The Electron main process spawns `afk observe runs` and
   `afk observe timeline --runId <id> --since <seq>` (subcommands
   already exist in `src/cli/commands/observe.ts`).
2. The renderer reaches these commands through a new typed IPC service
   (`run-log-service`) — no direct JSONL file access from the
   renderer.
3. Work-item → CLI-runId mapping is computed by scanning RunEvents for
   `context.workItemId === <id>` (the renderer queries
   `afk observe runs --filter workItemId:<id>` once such a flag exists,
   or falls back to scanning recent runs until the right one is found).
4. Live tail = poll `timeline --since <lastSequence>` every 2 s. No
   push channel.
5. The renderer does not see the JSONL root path; all access is
   mediated by `run-log-service`.

## Alternatives

### A. Read the unified pino log directly

- **Pros:** Single global file, easy to find, already on disk.
- **Cons:** Mixed across every work item + every command. Cannot answer
  "what happened for work item #158" without filtering. Rotates daily,
  can be truncated by `DayRotator` 7-day prune. Pino log is a
  projection per ADR-0016 and [[afk-logging-convention]]; reading it
  as authoritative would violate that decision. **Rejected.**

### B. Read the RunEvent JSONL files directly from the renderer

- **Pros:** Skips the CLI round-trip; tighter latency.
- **Cons:** Renderer-side file IO breaks the existing IPC discipline
  (every other desktop surface goes through a `services/` adapter and
  a typed IPC handler). Forces the renderer to implement JSONL parsing,
  base64url runId decoding, and integrity verification — duplicating
  `JsonlEventStore`. Couples renderer to event-store on-disk format,
  which ADR-0016 reserves the right to evolve. **Rejected.**

### C. Read the RunEvent JSONL files directly from the Electron main process

- **Pros:** Keeps IO in main process; renderer stays pure.
- **Cons:** Duplicates `JsonlEventStore` and the `observe` projection
  in a new file. Two readers of the same store means two parsers of
  the same on-disk format. The CLI already exposes the projection; we
  would be forking for no reason. **Rejected.**

### D. Push channel (IPC `webContents.send` from a `fs.watch` listener)

- **Pros:** Real-time; no poll latency.
- **Cons:** Adds `fs.watch` plumbing, lifecycle handling (the store
  directory may not exist yet), and per-event IPC marshalling for a
  feature whose stated value is "occasional inspection", not "live
  monitoring". The user can drop to `afk observe timeline --follow` if
  they need real-time. **Rejected for now;** revisit if R4 (pull-poll
  miss) becomes a real complaint.

## Consequences

**Positive:**

- One source of truth, shared with the CLI projection.
- Free integrity check via the audit-spine hash chain
  (`afk observe verify --runId <id>`).
- No format-coupling between renderer and on-disk JSONL.
- The desktop viewer, `afk observe timeline`, and future tooling all
  speak the same shape.
- Work-item correlation works without sharing the desktop's runId
  format.

**Negative:**

- Adds one extra process spawn per poll cycle. Mitigated by 2 s
  cadence and `afk observe`'s short startup; flagged for measurement
  in R4.
- Late events between polls can be missed by up to 2 s. Acceptable
  for the stated user value; upgrade path is option D.
- The renderer depends on `afk observe` being installed alongside
  `afk`. Already true today via the shim
  ([[afk-shim-dynamic-resolution]]); flagged for the deploy story.
- Cannot show logs older than the current `afk observe runs`
  retention. Same retention as the audit spine — single source of
  truth wins over completeness.

## Related

- [ADR-0016 — Run Event Audit Spine](0016-run-event-audit-spine.md)
- [ADR-0018 — Evidence Classification and Redaction](0018-evidence-classification-and-redaction.md)
  (relevant when RunEvent payloads include sensitive fields)
- [[afk-logging-convention]] (pino log is a projection, not authority)
- [[afk-shim-dynamic-resolution]] (CLI resolution)
- [[desktop-client-execfile-stdin]] (Electron main-process execFile
  gotcha — applies to `afk observe` invocations from
  `run-log-service`)
- [[desktop-client-process-executor-envelope]] (rejection carries
  stdout/stderr — `run-log-service` must read them to surface a useful
  error envelope)