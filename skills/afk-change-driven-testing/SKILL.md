---
name: afk-change-driven-testing
description: >-
  Adds focused regression protection for the business flow affected by a
  current code change. Use when modifying existing business logic, fixing a
  bug, or extending a legacy flow where unit, integration, or E2E coverage is
  missing or weak; do not use it to launch a repository-wide test-coverage project.
---

# Change-Driven Testing

**Goal:** Turn the current code change into a small, evidence-based test increment that protects the affected business behavior without expanding into unrelated modules.

## Steps

1. **Map the change before editing.** Read the task requirements, relevant source, callers/callees, existing tests, and project test conventions. Trace the affected business flow only far enough to identify meaningful boundaries, state changes, data writes, and external effects.

2. **Establish expected behavior.** Derive expectations from acceptance criteria, domain rules, API contracts, invariants, and confirmed examples. Separate confirmed behavior from observed implementation and unresolved assumptions. Do not treat every legacy behavior as correct; flag suspected bugs rather than encoding them as desired behavior.

3. **Inspect existing protection.** Find tests that actually assert the affected behavior. Identify missing scenarios, weak assertions, excessive mocking, shared-state risks, and whether the current tests would detect a plausible regression. Reuse effective tests; do not duplicate them just to increase test count.

4. **Create a scoped test plan.** List only the test cases needed for this change: behavior being changed, important unchanged behavior at risk, boundary and error paths, and relevant historical defects. Record each case's expected result and evidence source. Ask the user only when an unresolved business rule changes the expected result or implementation direction.

5. **Choose the lowest effective test layer.**
   - **Unit:** business rules, calculations, validation, permissions, branching, and state transitions in isolation.
   - **Integration:** collaboration across real boundaries such as database transactions, persistence, cache, messaging, authentication, and external-service adapters.
   - **E2E:** a small number of critical user journeys when component-level tests cannot prove the end-to-end outcome.
   Do not add all three layers by default. Do not mock the component or behavior under test.

6. **Add tests incrementally.** For a new or changed rule, write or update the focused test before implementation when practical. For an existing untested flow, first capture confirmed behavior with characterization tests, then change the behavior under test. If implementation already changed, derive tests from requirements and independent evidence rather than merely copying the new implementation. Keep code changes minimal and in scope.

7. **Run and diagnose.** Execute new tests and the narrowest relevant regression suite. Expand to broader suites when shared contracts, state, persistence, or downstream behavior could be affected. Classify failures as test defects, product defects, environment failures, pre-existing failures, or unresolved requirements. Never weaken assertions, skip tests, or alter unrelated production behavior just to get a green result.

8. **Report the increment.** Summarize the affected flow, test cases added or reused, commands actually executed and their results, and remaining high-risk gaps. Record unrelated test debt as a separate follow-up; do not fix it in this task.

## Completion Criteria

- The changed business behavior has explicit, meaningful assertions.
- Important adjacent behavior at risk has regression protection or a documented reason for exclusion.
- Tests run in the project-supported environment, with unexecuted checks clearly marked.
- The change has not silently expanded into repository-wide coverage work.
- Remaining uncertainty and uncovered risk are visible to the developer.

## Caveats

- MUST NOT use line coverage alone as proof of test quality.
- MUST NOT assume current behavior is the correct specification.
- MUST NOT generate tests that only assert a call occurred or that always pass.
- MUST NOT replace real integration verification with mocks of every dependency.
- MUST NOT introduce broad abstractions or production refactors solely to make tests easier without demonstrating the need.
- MUST NOT create unrelated tests for untouched modules unless the current change puts their behavior at risk.
