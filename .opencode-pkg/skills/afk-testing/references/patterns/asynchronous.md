# Asynchronous Workflow Pattern

Use when the initial request only accepts or schedules work and the final result becomes available later.

## Separate acceptance from completion

Test the acknowledgement independently from final completion. Capture the returned job ID, operation ID, or correlation ID and use it to observe the same work item. Never treat an accepted request as proof that the work succeeded.

## Completion oracle

Prefer a documented terminal state, observable event, callback, result resource, or project-provided wait helper. Use bounded polling only when no stronger observation mechanism exists. Poll for a specific condition and stop at a declared deadline; avoid fixed sleeps and unbounded loops.

Verify:
- accepted/rejected input and initial state;
- transition through relevant states, including failure/cancellation where applicable;
- final output and side effects;
- timeout behavior and whether work can be safely retried;
- duplicate submission and idempotency where specified.

## Determinism and cleanup

Use fake clocks, controlled executors, or in-memory adapters in unit tests when available. Integration tests should exercise the real boundary whose behavior matters. Always bound waiting time, report timeout separately from assertion failure, and clean up or isolate background work so it cannot affect other tests.
