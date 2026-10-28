# Event-Driven Pattern

Use when components communicate through a broker, queue, domain event bus, notification stream, or persisted event log.

## Discover the contract

Identify the producer, event name/type, schema/version, correlation key, consumer, and observable business outcome. Establish ordering guarantees from the contract; do not assume global order if the system does not promise it.

## Assertions

Verify:
- the event is emitted or accepted at the correct business transition;
- required payload fields, identifiers, schema version, and correlation metadata;
- the consumer's externally meaningful effect, not only that a handler was called;
- duplicate-delivery handling and idempotency when delivery may be repeated;
- ordering, retry, dead-letter, and poison-message behavior where contractually relevant;
- no event or state change on rejected operations when that is part of the rule.

Use the narrowest reliable harness: fake bus for unit tests, in-memory broker or containerized service for integration, and a small number of end-to-end flows for critical journeys. Avoid assertions on incidental timestamps or nondeterministic metadata unless the contract defines them.

## Evidence

Capture the event identity and sanitized payload, consumer outcome, correlation ID, and final state. Distinguish “event published” from “event processed successfully.”
