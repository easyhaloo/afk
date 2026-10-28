# Streaming, UI, Scheduling, and Batch Patterns

Load only the relevant sections for user interfaces, long-lived connections, periodic jobs, or bulk processing.

## Streaming responses (HTTP chunks, SSE, token streams)

Verify stream establishment, event/chunk framing, ordering where specified, partial chunks, completion marker, cancellation, disconnect/reconnect, timeout, backpressure, and error signaling. For LLM token streams, distinguish partial text from the finalized structured result. Do not require every chunk boundary to be identical unless framing is part of the contract.

## WebSocket and bidirectional sessions

Verify connection/authentication lifecycle, message schemas, correlation IDs, heartbeat/ping timeout, reconnect, duplicate messages, slow consumer behavior, and authorization after identity or session state changes. Test connection cleanup and server-side resource release.

## Frontend async state and optimistic updates

Assert visible loading, success, empty, validation-error, server-error, retry, and cancellation states. For optimistic UI, test rollback on server rejection, reconciliation with canonical server state, rapid repeated clicks, stale responses arriving out of order, and accessibility-visible feedback. Test user-observable behavior rather than component implementation details.

## Scheduled jobs and timers

Use controllable clocks or scheduler hooks where available. Test due/not-due boundaries, time zones and daylight-saving transitions where relevant, duplicate scheduler triggers, missed schedules, job overlap, cancellation, and restart recovery. Do not use arbitrary wall-clock sleeps when deterministic control is possible.

## Batch and bulk operations

Test empty/single/large batches, partial success, per-item error reporting, ordering if guaranteed, chunk/page boundaries, retry of failed subsets, duplicate items, limits, memory/resource boundaries, and resume/restart semantics. Verify one failing item does not silently corrupt or lose unrelated items unless all-or-nothing is the contract.

## Sources

- Azure Asynchronous Request-Reply: https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply
- Azure asynchronous messaging: https://learn.microsoft.com/en-us/azure/architecture/guide/technology-choices/messaging
- Playwright retries and worker isolation: https://playwright.dev/docs/test-retries
