# Testing Extension Contract

## Model

Compose independent dimensions:

| Dimension | Answers | Examples |
|---|---|---|
| Test layer | Which boundary is being verified? | Unit, integration, contract, E2E |
| Interaction pattern | How does work progress and how is completion observed? | Synchronous, asynchronous, event-driven, callback, streaming |
| Business domain | What entities and rules shape the scenario? | Accounts, tenant, status codes, uploaded files, orders |
| Test-design technique | How are cases generated or assessed? | Decision table, boundary values, property-based, model-based, mutation |
| Quality attribute | Which cross-cutting risk matters? | Security, reliability, performance, accessibility, observability |
| Oracle | What proves the behavior is correct? | Response contract, persisted state, emitted event, callback receipt, semantic rubric |

Do not encode these dimensions as one mutually exclusive test type. A scenario can use several interaction patterns, a business domain, one or more techniques, and multiple quality attributes at once.

## Extension points

1. **Pattern pack:** reusable guidance in `references/patterns/<pattern>.md`. Each pack defines when it applies, required inputs, setup, action, observable completion, assertions, negative cases, timeout/retry behavior, cleanup, and evidence.
2. **Project profile:** optional `docs/testing/TESTING-PROFILE.yaml` mapping business-rule sources, existing test commands, fixtures, factories, adapters, and enabled patterns. Treat it as project configuration only after validating it; the template contains placeholders, not authoritative project facts.
3. **Business-rule source:** explicit requirements, API/event schemas, domain invariants, status mappings, or user-provided rule files. Record a stable rule ID and source location for each important scenario.
4. **Project test adapter:** reuse the repository's native test clients, account/data factories, fake callback receivers, event harnesses, upload helpers, and LLM stubs. Keep executable adapters in the project's test-support directories, not in this generic Skill.

## Discovery and precedence

Use information in this order:
1. Explicit constraints and rule files supplied for the current task.
2. Validated project testing profile and project-local agent/developer instructions.
3. Existing tests, fixtures, test configuration, and CI conventions.
4. Built-in pattern guidance.

Existing behavior is evidence, not automatically the expected business behavior. If sources conflict, record the conflict; do not silently choose one.

## Required scenario contract

For each meaningful scenario, capture:
- Rule ID and source;
- preconditions and constructed identities/data;
- trigger/action;
- interaction pattern(s) and test layer;
- expected observable result and assertion oracle;
- completion signal, timeout, retry and consistency rules when applicable;
- cleanup/isolation requirements;
- test file or planned location;
- execution evidence and uncovered risk.

Use the project's existing plan/report conventions where they already exist. Otherwise use the templates in this Skill. Keep simple tasks lightweight; do not create documents only to satisfy ceremony.

## Adding an extension

Add a focused pattern reference only when the pattern is reusable beyond one task. Add business-specific rules to the project-owned rule source/profile, not to the generic Skill. Add code helpers to the project's native test-support area. Update `SKILL.md` only when routing or the extension contract itself changes.

Never load every pattern by default. Select the smallest set that fully describes the observed workflow.
