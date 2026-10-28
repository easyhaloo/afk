# Test Design and Test-Quality Techniques

These are techniques, not runtime interaction patterns. Select them based on risk and available tooling.

## Behavior-driven and acceptance examples

For business-facing behavior, express important scenarios as Given/When/Then
or equivalent examples. Each example needs a confirmed rule, an observable
outcome, and a clear boundary. Keep business-readable acceptance scenarios
separate from implementation-specific unit tests; link them through stable
rule/scenario IDs rather than duplicating every assertion at every layer.

## Example-based and table-driven tests

Use representative examples for business rules and a decision table when outcomes depend on combinations of roles, states, inputs, or configuration. Avoid a full Cartesian product when combinations are invalid or redundant.

## Boundary-value and equivalence-partition tests

Identify valid and invalid partitions, lower/upper boundaries, empty/missing/null values, limits, and off-by-one cases. Derive boundaries from requirements and contracts rather than arbitrary round numbers.

## Property-based and metamorphic testing

Use property-based tests for invariants across generated inputs (for example, normalization idempotence or encode/decode round trips). Use metamorphic relations when the exact answer is hard to compute but transformations imply predictable relationships. Keep generators bounded and failures reproducible with seeds/examples.

## Fuzz testing

Use for parsers, decoders, serializers, protocol handlers, file formats, user input, and other complex input surfaces. Enforce time/resource limits and retain minimized reproductions. Do not replace meaningful business assertions with "does not crash" unless crash resistance is the stated property.

## Model-based and stateful testing

Represent allowed states, transitions, commands, and invariants. Generate sequences and compare the implementation with the model, especially for workflows, queues, account lifecycle and retryable operations. Ensure failing sequences can be replayed deterministically.

## Differential testing

Compare the behavior of two implementations, versions, providers, parsers, or migration paths against the same input. Define which differences are allowed; do not assume two systems are equivalent when the contract changed intentionally.

## Golden / snapshot tests

Use snapshots for stable serialization, public schemas, CLI output, or generated artifacts where broad structured diffs are useful. Avoid giant opaque snapshots that hide the relevant assertion. Review and explain snapshot updates; never refresh them blindly to make a failure pass.

## Mutation testing and negative controls

Mutate conditions, boundaries, return values or selected behavior, then verify tests detect the change. Use a safe test-level negative control when available. Interpret surviving mutants: some are equivalent or irrelevant, so mutation score is diagnostic, not a standalone quality score. Never alter production code in a test-only task just to make a test fail.

## Exploratory and risk-based testing

Use exploratory testing to discover undocumented behavior and hidden edge cases. Convert confirmed defects into regression tests. Prioritize by business impact, likelihood, change size, data/security exposure, and failure detectability.

## Isolation, determinism, and flaky-test diagnosis

Prefer isolated data, deterministic fixtures, controlled clocks, bounded waits, and explicit cleanup. Classify flaky tests using recorded attempts and environment details; never silently retry until green. A retry pass is evidence of nondeterminism, not proof the original failure was irrelevant.

## Test granularity

Use a balanced test portfolio with fast, focused tests at lower boundaries and a small number of high-level tests where integration confidence is added. Do not duplicate all lower-level assertions in E2E tests. Keep contract, integration, acceptance and E2E tests distinct by the claim each proves.

## Sources

- Martin Fowler, Practical Test Pyramid: https://www.martinfowler.com/articles/practical-test-pyramid.html
- Playwright, retries and isolation: https://playwright.dev/docs/test-retries
- Pact, contract testing: https://docs.pact.io/getting_started/how_pact_works
