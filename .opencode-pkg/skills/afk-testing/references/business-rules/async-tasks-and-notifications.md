# Async Tasks and Notification Rules

Use these candidates when a product runs background work, consumes messages, or
sends user-visible or system notifications.

## Background work

### ASYNC-001 — Acceptance is distinct from completion
If a request starts asynchronous work, an acknowledgement that work was
accepted must not be represented as proof that the work completed successfully.
The client must have the documented means to observe progress or a terminal
result where such tracking is part of the product contract.

**Test angles:** accepted versus completed response; task-status lookup; delayed
completion; terminal failure; correlation between request and task.

### ASYNC-002 — Task status and result remain consistent
A task's reported status must agree with its available result and side effects.
The task must not report success before required work is complete, or remain
permanently pending after a terminal outcome has been recorded.

**Project decisions to confirm:** state model, terminal states, progress updates,
and whether results are eventually consistent.

**Test angles:** status/result mismatch; worker crash after side effect; status
polling around completion; stale task views.

### ASYNC-003 — Duplicate delivery does not duplicate protected business effects
Where messages, events, callbacks, or job triggers may be delivered more than
once, the consumer must protect operations that require once-per-logical-task
effects according to the product's idempotency contract.

**Test angles:** repeated event; duplicate queue message; webhook retry; concurrent
workers; replay after consumer restart.

### ASYNC-004 — Retry and terminal failure follow a bounded policy
Transient failures may be retried according to the documented policy, while
permanent failures must not cause unbounded retry loops. A terminal failure
must remain diagnosable and must not be silently reported as success.

**Project decisions to confirm:** retryable error classes, attempts/backoff,
dead-letter or manual-recovery behavior, and user-visible failure state.

**Test angles:** transient then recovered failure; permanent failure; exhausted
attempts; retry storm prevention; replay after repair.

### ASYNC-005 — Cancellation and timeout outcomes are truthful
When the product offers cancellation or deadlines, the result must describe
what actually stopped. A cancelled client wait does not by itself prove that the
server-side task stopped; irreversible side effects need the documented
cancellation/compensation semantics.

**Project decisions to confirm:** cancellation boundary, cleanup, compensation,
and behavior when cancellation races with completion.

**Test angles:** cancel before start, during work, and after completion; deadline
expiry; repeated cancellation; late worker result.

## Notifications and delivery

### NOTICE-001 — Notifications go only to intended recipients
Notifications must follow the product's recipient, tenant, visibility, and
consent rules. Data intended for one user or organization must not leak through
another user's email, push message, inbox, or webhook.

**Project decisions to confirm:** subscriptions, opt-outs, delegation, external
recipient policy, and whether delivery is mandatory or best-effort.

**Test angles:** recipient selection; cross-tenant recipients; removed membership;
multiple channels; recipient changes before delivery.

### NOTICE-002 — Delivery outcome matches the declared delivery guarantee
When delivery is retried or acknowledged asynchronously, the system must not
claim delivery merely because a message was queued, unless the contract defines
that acknowledgement as the relevant success boundary. Duplicate delivery,
deduplication, and ordering follow the product's stated guarantee.

**Project decisions to confirm:** accepted, sent, delivered, or read semantics;
at-least-once versus best-effort delivery; deduplication and ordering guarantees.

**Test angles:** provider rejects message; provider timeout after accepting;
duplicate attempt; delayed callback; event ordering.

### NOTICE-003 — Notification content respects privacy and presentation rules
A notification must contain only information appropriate for the selected
recipient and channel. Sensitive values should not be placed in subject lines,
push previews, URLs, or delivery logs unless explicitly approved.

**Test angles:** rendered email/push/in-app content; template variables; hidden
recipients; URL parameters; logs and provider error messages.
