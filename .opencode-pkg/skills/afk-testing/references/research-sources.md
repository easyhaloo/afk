# Testing Pattern Research Sources

This catalog consolidates public references used to build AFK Testing's pattern taxonomy. The taxonomy is intentionally broader than any single vendor's catalog. Load a source when its specific design contract applies; do not treat all patterns as mandatory.

## Testing strategy and granularity

- Ham Vocke / Martin Fowler, The Practical Test Pyramid: https://www.martinfowler.com/articles/practical-test-pyramid.html
  - Test granularity, focused integration boundaries, contract tests, UI/E2E trade-offs, exploratory testing, and keeping high-level tests small.
- Pact, How Pact works: https://docs.pact.io/getting_started/how_pact_works
  - Consumer/provider contracts for HTTP and asynchronous messages.
- Playwright, Retries: https://playwright.dev/docs/test-retries
  - Worker isolation and the need for independent tests when retrying flaky cases.

## Distributed interaction and resilience patterns

- Microsoft Azure Architecture Center, Cloud Design Patterns: https://learn.microsoft.com/en-us/azure/architecture/patterns
  - A broad catalog including messaging, publisher/subscriber, queue-based load leveling, competing consumers, retry, saga, throttling, and claim check.
- Microsoft Azure, Asynchronous Request-Reply: https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply
  - Accepted vs completed work, polling, status resources, callbacks, streaming alternatives, cancellation, idempotency.
- Microsoft Azure, Circuit Breaker: https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
  - Failure thresholds, open/half-open states, recovery and distinction from retries.
- Microsoft Azure, Throttling: https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling
  - Per-principal limits, concurrency limits, and controlled overload.
- Microsoft Azure, Competing Consumers: https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers
  - Concurrent queue consumers and throughput scaling.
- Microsoft Azure, Saga: https://learn.microsoft.com/en-us/azure/architecture/patterns/saga
  - Multi-service workflows, compensation and eventual consistency.
- Microsoft Azure, Asynchronous Messaging: https://learn.microsoft.com/en-us/azure/architecture/guide/technology-choices/messaging
  - Reliable messaging, load leveling, message size and consumer behavior.
- AWS Prescriptive Guidance, Asynchronous Communication: https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-integrating-microservices/asynchronous.html
  - Callback retry/timeout, message ordering, state reconciliation, dead-letter handling and observability.

## Security and business identity

- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
  - A structured reference for web application security test scenarios. Select relevant categories based on the application's actual attack surface.

## Code-level behavioral design patterns

- Refactoring.Guru, Behavioral Design Patterns: https://refactoring.guru/design-patterns/behavioral-patterns
  - Strategy, Observer, Command, State, Chain of Responsibility, Mediator, Template Method, Iterator, Memento, Visitor and Interpreter.

## Use and maintenance policy

- Prefer standards, official product documentation, and canonical pattern references for project-specific contracts.
- Record the source URL and relevant section with important business rules and generated test expectations.
- Re-check source guidance when a project's behavior relies on versioned external protocols, framework semantics or vendor-specific delivery guarantees.
- Do not copy a reference catalog mechanically into a test plan. Select patterns only when the source code, architecture or requested scenario uses them.
