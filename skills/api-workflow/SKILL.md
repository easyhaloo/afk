---
name: api-workflow
description: Build reliable Playwright tests for multi-step API workflows by discovering the application's real APIs, authentication, state transitions, async behavior, and authoritative verification sources, then mapping the business workflow to the smallest executable test.
---

# API Workflow

> **API Workflow:** Discover the application's real API, authentication, state transitions, asynchronous behavior, and authoritative data sources, then translate the requested business workflow into the smallest reliable Playwright test. Before generating anything, inspect the relevant references, templates, scripts, and examples together with the target codebase. Reuse them when they fit the repository; adapt or replace them when evidence shows they do not. Ask only for decisions that cannot be established from available evidence, and verify the complete workflow against its real success conditions.

## Discover

Inspect the target codebase, existing tests, Playwright configuration, relevant documentation, and the complete applicable skill context:

- `references/` — reusable patterns, constraints, and domain knowledge
- `templates/` — optional scaffolding and implementation building blocks
- `scripts/` — validators or executable checks that define verifiable expectations
- `examples/` — illustrative combinations, not normative requirements

Establish:

- API routes, request/response contracts, and required dependencies
- authentication and session mechanisms
- state transitions and data dependencies
- asynchronous triggers, completion signals, polling, or callbacks
- authoritative sources for final verification
- existing fixtures, utilities, setup, and project layout
- local/CI execution constraints

Do not infer API behavior when the implementation, tests, documentation, or executable evidence can establish it.

## Model the Workflow

Represent the requested scenario as a business workflow before generating code. Identify the sequence of actions, state passed between them, asynchronous boundaries, and observable success conditions.

Map business steps to actual API and browser operations only after the workflow is understood. Use references for reusable patterns, templates for scaffolding, and examples for composition ideas. Do not copy an example blindly or introduce template infrastructure that the target project does not need.

A typical workflow may look like:

```text
Business Action
  → API Trigger
  → Returned State / ID
  → Poll or Await Completion
  → Authoritative API Verification
  → Browser Verification
```

The actual sequence must come from the application.

## Authentication

Select authentication from the application's real auth model, execution environment, and existing test infrastructure. Treat authentication references and templates as implementation options, not a fixed decision tree.

Use an existing repository-supported strategy whenever possible. If a required identity, session, environment, or auth capability cannot be established, stop and ask for the missing information instead of generating speculative credentials or bypasses.

## Generate

Generate only the artifacts required by the selected workflow and existing project structure. Reuse compatible fixtures, utilities, setup, authentication helpers, templates, and configuration rather than creating parallel infrastructure.

Templates are starting points, not mandatory files. Preserve project conventions and remove unused scaffold when adapting them. Keep credentials, secrets, auth state, and environment-specific values outside source-controlled test code.

## Validate

Use relevant executable checks from `scripts/` when they apply. Treat validator failures as evidence that the generated artifacts or their assumptions need review; do not weaken tests merely to satisfy a validator.

Before execution, verify that references, templates, scripts, and examples remain internally consistent with the workflow and selected authentication strategy.

## Verify

Execute the generated test against the real target environment when available. Verify the original business workflow, including API results, asynchronous completion, state transitions, and browser-visible outcomes when applicable.

A passing individual API request is not sufficient if the workflow depends on later state or UI behavior. Prefer authoritative state over cached or incidental observations.

If execution fails, diagnose the failure using observed evidence and correct the workflow or test only when the evidence supports the change. Do not mask application failures by weakening assertions.

## Output

Produce the executable test and only the supporting artifacts required to run it. Report the discovered workflow, authentication strategy, verification strategy, validation/execution result, and any unresolved environment or application constraints.

> **Principles:** Discover before generating. Inspect the whole skill context. Model the business workflow before writing tests. References inform; templates scaffold; scripts validate; examples illustrate. Evidence over assumptions. Reuse existing infrastructure. Generate only what is required. Verify the complete workflow, not isolated requests.
