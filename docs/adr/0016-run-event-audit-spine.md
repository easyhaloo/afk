# ADR-0016: Run Event Audit Spine
## Status
Accepted
## Context
AFK currently emits structured logs, mutable task runtime snapshots, tracker
labels, and agent diagnostics. None alone can reconstruct a complete run after
restart or explain a state transition across loop, workflow, QA, and human gates.
## Decision
A versioned, append-only `RunEvent` stream is the authoritative record of each
run. Every external effect must receive `ObservationContext` and append durable
intent and outcome events. The context includes run, work item, trace,
correlation, attempt, profile, actor, and lease epoch identifiers. Event streams
are ordered per run, include causation and idempotency keys, and are hash chained.
Logs, traces, metrics, task-runtime records, CLI output, and the board are
projections or correlated diagnostic signals; they are not authoritative state.
The initial store is a local JSONL adapter with atomic append and verification.
## Consequences
State may be replayed deterministically, interrupted runs can be explained, and
side effects become auditable. Event persistence is a fail-closed precondition
for automated external writes and merges. This for automated external writes and merges. This for automated external write
