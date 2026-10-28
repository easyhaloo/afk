# API, Contract, Persistence, and Data Patterns

Load when the behavior crosses an API, schema, database, cache, filesystem, or external-service boundary.

## Request/response and API contracts

Verify method, route, required/optional fields, validation rules, transport status, business error code, response schema, compatibility, authorization, and documented side effects. Keep transport status distinct from application error code and persisted domain state.

## Consumer-driven and provider contracts

For each consumer interaction, assert the minimum request, response, or message schema the consumer depends upon. Verify provider changes against consumer contracts and test both producer serialization and consumer deserialization. Keep contract tests about the integration boundary; do not turn them into broad provider business-logic tests.

## Serialization and schema evolution

Test missing/unknown fields, defaults, nullability, enum evolution, timestamp/decimal handling, version compatibility, malformed payloads, and forward/backward compatibility required by deployment order. Include event/message schemas where applicable.

## Database and transactional behavior

Verify committed state through the supported persistence boundary, constraints, uniqueness, rollback, transaction isolation, data migration and cleanup. Use a real test database when engine-specific behavior is central; use fakes only when the real boundary is not the subject.

## Cache and invalidation

Test cache hit/miss, stale values, invalidation after mutation, expiry, concurrent cache fill, fallback to source of truth, and tenant/key isolation. Do not assume cache and database are strongly consistent unless that is the declared contract.

## Pagination, filtering, sorting, and batch APIs

Test first/last/empty pages, stable continuation tokens, limit boundaries, filters that combine, sorting ties, duplicate or missing records, authorization across pages, and consistency while the underlying dataset changes.

## External integrations and adapters

Cover valid and malformed responses, timeouts, provider error mapping, rate limits, authentication expiration, unavailable dependencies, and contract drift. Prefer local fakes/recorded fixtures for deterministic tests, plus a small explicitly opted-in sandbox integration suite where live interoperability matters.

## Sources

- Martin Fowler, Practical Test Pyramid: https://www.martinfowler.com/articles/practical-test-pyramid.html
- Pact, How Pact works: https://docs.pact.io/getting_started/how_pact_works
- Azure Cloud Design Patterns: https://learn.microsoft.com/en-us/azure/architecture/patterns
