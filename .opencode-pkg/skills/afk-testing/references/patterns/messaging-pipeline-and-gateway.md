# Messaging, Pipeline, and Gateway Patterns

Load when a request or payload crosses multiple delivery components, filters, gateways, or downstream services.

## Queue-based load leveling and backpressure

Verify that bursty producers can enqueue within configured limits while consumers process at a controlled rate. Test queue capacity, overload response, rejection or buffering policy, backlog drain after recovery, visibility of queue age/depth, and bounded memory/storage use. Test backpressure propagation when a downstream consumer is slow.

## Priority queues and fair scheduling

Create jobs in different priority classes and verify the documented scheduling guarantees under load. Test equal-priority ordering only when promised, starvation controls, reprioritization, cancellation, and behavior when a high-priority stream continuously arrives. Do not assume strict ordering across independent partitions unless specified.

## Pipes and filters / processing pipelines

Test each filter's input/output contract, ordering, error routing, retry boundary, and data/schema preservation across stages. Inject failure at each material stage, malformed intermediate data, empty input, and cancellation. Verify whether the pipeline is fail-fast, best-effort, or partial-result by contract. Assert that a failed stage does not silently skip required validation or duplicate non-idempotent downstream effects.

## API gateway, gateway aggregation, BFF, and API composition

Test routing, authentication/authorization propagation, header and correlation handling, request/response transformation, per-downstream timeout, partial dependency failure, and response aggregation policy. For BFFs, verify client-specific behavior without leaking one principal or tenant's data to another. Test that failures from one downstream service follow the documented partial-result or fail-fast policy.

## Messaging bridge and protocol adapter

Verify both sides' schema and protocol transformations, acknowledgements, correlation IDs, delivery semantics, error conversion, and preservation of business identifiers. Test malformed messages, unsupported versions, partial outages, and duplicate transfer. Keep provider-specific transport behavior separate from the business contract.

## Sources

- Microsoft Azure Cloud Design Patterns: https://learn.microsoft.com/en-us/azure/architecture/patterns
- Microsoft Azure Asynchronous Messaging Options: https://learn.microsoft.com/en-us/azure/architecture/guide/technology-choices/messaging
- Microsoft Azure Competing Consumers: https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers
