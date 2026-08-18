---
name: api-workflow
description: Build reliable Playwright tests for multi-step API workflows by discovering the application's real APIs, authentication, state transitions, async behavior, and authoritative verification sources, then mapping the business workflow to the smallest executable test.
---

# API Workflow

> **API Workflow:** Discover the application's real API, authentication, state transitions, asynchronous behavior, and authoritative data sources, then translate the requested business workflow into the smallest reliable Playwright test. Reuse existing test infrastructure and references, resolve strategy from evidence, ask only for decisions that cannot be established from the repository or environment, and verify the workflow against its real success conditions.

## Discover

Inspect the codebase, existing tests, Playwright configuration, relevant documentation, and all applicable files under `references/` and `templates/` before designing the test.

Establish:

- API routes, request/response contracts, and required dependencies
- authentication and session mechanisms
- state transitions and data dependencies
- asynchronous triggers, completion signals, polling, or callbacks
- authoritative sources for final verification
- existing fixtures, utilities, setup, and project layout
- local/CI execution constraints

Do not infer API behavior when the implementation, tests, or documentation can establish it.

## Model the Workflow

Represent the requested scenario as a business workflow before generating code. Identify the sequence of actions, state passed between them, asynchronous boundaries, and observable success conditions.

Map business steps to the actual API and browser operations only after the workflow is understood. Reuse existing patterns from `references/api-patterns/` and `references/hybrid-patterns/` rather than duplicating their implementation details in this skill.

A typical workflow may look like:

```text
Business Action
  → API Trigger
  → Returned State / ID
  → Poll or Await Completion
  → Authoritative API Verification
  → Browser Verification
```

The actual sequence must come from the application rather than this example.

## Authentication

Select authentication from actual execution constraints and available mechanisms, not from a fixed preference. Prefer an existing repository-supported strategy.

For browser-session workflows, use `localhost-cdp` only when an interactive Chromium session is intentionally available locally. Use `storage-state` or another repository-supported scripted mechanism when execution is non-interactive. Do not silently fall back between incompatible authentication strategies.

When no reliable authentication strategy can be established, stop and ask for the missing environment or test identity rather than generating a speculative solution.

## Generate

Generate only the artifacts required by the selected workflow and existing project structure. Reuse root Playwright configuration, fixtures, utilities, authentication setup, templates, and environment conventions whenever available.

Do not create parallel infrastructure when existing test infrastructure can support the workflow. Keep credentials, secrets, and environment-specific values outside test source.

Before changing files, confirm only decisions that cannot be established from evidence and that materially affect the generated workflow or its execution.

## Verify

Execute the generated test against the real target environment when available. Verify the original business workflow, including API results, asynchronous completion, state transitions, and browser-visible outcomes when applicable.

A passing individual API request is not sufficient if the workflow depends on later state or UI behavior. Prefer authoritative state over cached or incidental observations.

If execution fails, diagnose the failure using the observed evidence and correct the workflow or test only when the evidence supports the change. Do not mask application failures by weakening assertions.

## Output

Produce the executable test and only the supporting artifacts required to run it. Report the discovered workflow, authentication strategy, verification strategy, execution result, and any unresolved environment or application constraints.

> **Principles:** Discover before generating. Model the business workflow before writing tests. Evidence over assumptions. Reuse existing infrastructure. Generate only what is required. Verify the complete workflow, not isolated requests. Never hide failures by weakening assertions.
