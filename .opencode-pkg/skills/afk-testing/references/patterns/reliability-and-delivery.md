# Reliability, Delivery, and Recovery Patterns

Load for code interacting with unreliable networks, queues, remote services, storage, or background workers.

## Timeout and cancellation

Test deadline propagation, cancellation before start and during execution, resource cleanup, state after cancellation, and races between cancellation and completion. A timeout must not be confused with confirmed cancellation if the work may continue remotely.

## Retry and backoff

Exercise transient versus permanent failure, attempt limits, backoff and jitter policy where testable, deadline exhaustion, and the final surfaced error. Ensure non-idempotent side effects are not repeated unsafely. Tests must record retries and must not silently retry a failing test until green.

## Idempotency and deduplication

Repeat the same logical request or message with the same idempotency key, including after a simulated lost response or worker crash. Assert the promised response semantics and that externally observable business effects occur only as often as the contract permits. Also test key scope, expiry, and key reuse with a different payload if defined by the API.

## Circuit breaker, bulkhead, and graceful degradation

Circuit breaker: verify closed/open/half-open transitions and that open state short-circuits calls. Bulkhead: saturate one isolated pool and verify unrelated work still progresses. Degradation/fallback: inject dependency failure and verify the documented fallback, warning/telemetry, and recovery behavior.

## Rate limiting and throttling

Test per-user/tenant/resource dimensions, boundary values, concurrent requests, reset windows, response/error contract, and fairness guarantees where specified. Load test the rejection path rather than checking only the normal path.

## Queue redelivery, dead-letter, and replay

Cover poison messages, maximum delivery count, dead-letter metadata, manual/automated replay, schema mismatch, and replay idempotency. Distinguish "message acknowledged" from "business operation completed." Test duplicate and out-of-order delivery if the broker or design permits them.

## Failover and partial dependency outage

Disable or delay one dependency and check the expected failure boundary, fallback, recovery and health signals. Avoid tests that depend on destabilizing shared infrastructure; use local fakes, fault injection, or isolated test environments.

## Sources

- Azure Retry and resilience pattern catalog: https://learn.microsoft.com/en-us/azure/architecture/patterns
- Azure Circuit Breaker: https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
- Azure Throttling: https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling
- Azure Competing Consumers: https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers
- AWS asynchronous communication: https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-integrating-microservices/asynchronous.html
