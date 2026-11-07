# Workflow, State, and Transaction Patterns

Load this reference when business behavior spans multiple states, steps, services, or recoverable transactions.

## State machines and transitions

Identify the state set, allowed transitions, guards, terminal states, and side effects. Build a transition table from confirmed rules. Test valid transitions, rejected transitions, repeated commands, concurrent transitions, and terminal-state behavior. Assert persisted state and emitted effects, not only the method return.

## Long-running workflows and process managers

For each step, capture input, output, checkpoint, failure path, retry policy, timeout, cancellation semantics, and compensation. Verify resume/replay behavior and that completed steps are not repeated unsafely. Test partial completion and recovery after interruption.

## Saga and compensating transactions

A saga spans independently committed steps and may require compensating actions. Inject a failure at each material step; verify completed actions, compensation order, terminal outcome, and handling when compensation itself fails. Do not assert impossible global atomicity where only eventual consistency is promised.

## Orchestration, choreography, and fan-out/fan-in

For orchestrated workflows, verify the coordinator's step order, timeout, retry,
resume, and failure routing. For choreographed workflows, verify each event
contract and that consumers react only to relevant events without relying on a
hidden global order. Test duplicate triggers and partial progress.

For fan-out/fan-in or scatter-gather flows, vary one slow/failing branch, all
branches failing, partial results, duplicate responses, correlation IDs, and
deadline expiry. Assert the aggregation policy (all-required, quorum, best
effort, or partial result) from the documented contract; do not assume every
branch must succeed if the design allows partial results.

## Event sourcing and CQRS

For event-sourced systems, verify decisions through the emitted event sequence and the resulting aggregate state. Test event schema/version compatibility, replay determinism, duplicate events, and projection rebuilds. For CQRS, distinguish command acceptance/write-model state from query-model propagation; assert the documented consistency window rather than assuming immediate read-after-write.

## Transactional outbox and inbox / deduplication

Where state changes and event publication must remain consistent, test the transaction boundary, crash/restart between commit and publication, duplicate delivery, and outbox draining. Assert that the event is eventually published and that consumers do not apply the same business effect more than once when deduplication is part of the contract.

## Sources

- Azure Saga pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/saga
- Azure Cloud Design Patterns: https://learn.microsoft.com/en-us/azure/architecture/patterns
- Azure Asynchronous Request-Reply: https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply
