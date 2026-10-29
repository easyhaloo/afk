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
2. **Built-in business-rule library:** natural-language candidate rules in `references/business-rules/`. Use it to discover common account, access-control, file, data-lifecycle, async, and audit scenarios. The library is reusable guidance, not an automatically enabled project specification.
3. **Project profile:** optional `docs/testing/TESTING-PROFILE.yaml` mapping authoritative project-rule sources, existing test commands, fixtures, factories, adapters, and enabled patterns. Treat it as project configuration only after validating it; the template contains placeholders, not authoritative project facts.
4. **Project business-rule source:** existing requirements, PRDs, API/event schemas, domain invariants, status mappings, and user-provided natural-language rule documents. Prefer the project's existing documentation conventions; if none exist, a team may maintain confirmed rules under `.afk/testing/rules/`. Record a stable rule ID and source location for each important scenario.
5. **Project test adapter:** reuse the repository's native test clients, account/data factories, fake callback receivers, event harnesses, upload helpers, and LLM stubs. Keep executable adapters in the project's test-support directories, not in this generic Skill.

## Rule authority and discovery

Use information in this order:
1. Explicit requirements, constraints, and rule descriptions supplied for the current task.
2. Project-owned business-rule documents, PRDs, API/event contracts, and other authoritative specifications.
3. A validated project testing profile and project-local agent/developer instructions.
4. Existing tests, fixtures, test configuration, and CI conventions as behavioral evidence.
5. The built-in business-rule library and pattern catalog as scenario-discovery aids.

The built-in business-rule library is not a source of project truth. Apply a candidate only when its capability exists and its applicability is established. Mark a rule as confirmed, observed, assumed, or unresolved. Organization-specific policies—such as account-key uniqueness, verification requirements, file limits, retention periods, and delete semantics—must come from project evidence or an explicit human decision. If sources conflict, record the conflict; do not silently choose one. Existing behavior is evidence, not automatically the expected business behavior.

## Required scenario contract

For each meaningful scenario, capture:
- Rule ID and source, distinguishing a built-in candidate from a project-authoritative rule;
- applicability and confirmation status;
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

Add a focused pattern reference only when the pattern is reusable beyond one task. Add company-wide business-rule candidates to `references/business-rules/`; add authoritative project-specific rules to the project's own docs, not to the generic Skill. Add code helpers to the project's native test-support area. Update `SKILL.md` only when routing or the extension contract itself changes.

Never load every pattern or rule pack by default. Select the smallest set that fully describes the observed workflow.
