# API Testing Pitfalls

Use these pitfalls when reviewing or generating API workflow tests. Treat them as diagnostic guidance, not as a mandatory generation checklist.

## Configuration

- Derive `testDir` from the actual Playwright configuration and test location; do not assume a repository layout.
- Keep `baseURL` environment-driven unless the repository explicitly defines a fixed target.
- Reuse existing Playwright configuration rather than creating a parallel configuration.

## Naming and Discovery

- Follow the repository's existing test naming and discovery conventions.
- For Playwright projects that use the default discovery rules, ensure generated test files match the configured pattern; do not assume `.spec.ts` if the configuration defines another pattern.

## Async State and Authoritative Data

- Do not assume a response immediately after an asynchronous trigger represents the terminal state.
- Poll or await the application's actual completion signal when the workflow is asynchronous.
- Do not use cached or incidental responses as authoritative verification when the application exposes a stronger source of truth.

## Test Isolation

- Avoid shared mutable module-level state between tests when it can leak failures or retries across cases.
- Prefer isolated Playwright contexts and repository-supported fixtures.
- Dispose explicitly created API contexts and other resources when the repository's infrastructure does not already manage their lifecycle.

## Assertions

- A successful HTTP response alone does not prove the business workflow succeeded.
- Assert the response contract and the state transition that matters to the workflow.
- Do not replace meaningful assertions with logging or weaken assertions merely to make a test pass.

## Environment and Secrets

- Never hardcode credentials or secret fallbacks in test source.
- Use the repository's existing environment/secret mechanism and fail clearly when required credentials are unavailable.
- Treat authentication state files, browser profiles, and debugging endpoints as credentials and keep them outside version control.

## Before Generation

Before generating a test, use repository evidence to establish the actual routes, authentication requirements, request/response contracts, state transitions, asynchronous boundaries, authoritative verification sources, test configuration, and environment constraints.

If the evidence is sufficient, proceed without unnecessary user confirmation. Ask only when a missing fact materially affects the workflow or execution strategy and cannot be established from the repository or environment.