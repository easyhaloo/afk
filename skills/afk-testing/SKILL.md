---
name: afk-testing
description: >-
  Designs, adds or updates tests, runs test suites, diagnoses failures, and
  assesses test effectiveness for software changes and AI coding workflows.
  Use when testing is the primary task or an implementation needs specialist
  test work. Use afk-change-driven-testing for a dedicated legacy-coverage
  task and afk-qa for independent verification of a managed backlog item.
---

# Testing

**Goal:** turn a defined behavior or code change into meaningful tests and trustworthy verification evidence without changing production behavior.

## Scope

Own test design, test code and fixtures, execution, failure diagnosis, test-quality assessment, and test reporting. The skill can be invoked directly by a developer or agent, or used by an implementation workflow for test-only work.

Do not implement features, fix production defects, refactor production code, redefine acceptance criteria, or approve/publish a change request. When a failure points to a production defect, report reproducible evidence and hand it back to the implementation workflow.

## Route the request

- **Testing is the primary task:** use this skill to design, add/update tests, run checks, diagnose failures, or review test effectiveness.
- **Feature or bug implementation:** `afk-implement` owns production changes and its TDD loop. Use this skill for substantial test design, test-only edits, cross-layer test work, or difficult test failures; do not delegate each ordinary Red-Green iteration.
- **Dedicated coverage expansion for existing business flows:** use `afk-change-driven-testing` when the task is specifically to add missing regression protection without changing production behavior and requires its scoped `TEST-PLAN.md` / `TEST-REPORT.md` workflow.
- **Managed backlog item already in verification:** use `afk-qa` for the independent acceptance gate. Do not substitute this skill's self-reported result for QA's fresh checks.
- **Agent or Skill behavior:** test observable tool calls, arguments, state transitions, artifacts, and task outcomes. Do not require exact matching of unconstrained natural-language output.

## Extensibility

Treat test layer, runtime interaction pattern, business rules/domain, test-design technique, quality attributes, and assertion oracle as independent dimensions. A scenario may combine multiple patterns, such as an asynchronous file upload completed by an event and followed by a callback.
Do not create a new Skill for each combination.

Before planning, load `references/extension-contract.md`. Read only the pattern
references relevant to the request. If the project provides
`docs/testing/TESTING-PROFILE.yaml`, explicit business-rule files, or test
support helpers, use them as project-specific configuration; do not assume the
template is already configured or invent missing values.

Browse `references/patterns/README.md` and `references/patterns/catalog.yaml` to select built-in patterns, then load only the relevant references. Consult `references/research-sources.md` when a pattern contract needs external verification.

The profile and templates under `templates/` are optional starting points. Use `templates/TESTING-PROFILE.yaml` as the project profile starter, `templates/TEST-PLAN.md` for non-trivial test planning, and `templates/TEST-REPORT.md` for the evidence report unless the project already has an equivalent convention.
Project-specific constructors, clients, fake servers, and adapters belong in
the repository's existing test-support structure and native language. Prefer
reusing those helpers. Add a new reusable helper only when repeated test
scenarios demonstrate the need; do not introduce a parallel testing framework.

## Workflow

### 1. Establish scope and inspect the project

Identify the target behavior, affected files and business flow, acceptance criteria, relevant callers, existing tests, fixtures, test framework, canonical test commands, environment dependencies, and CI checks. Read project-local guidance before applying generic conventions.

Preserve user changes. Do not reset, clean, or overwrite the worktree to create a test baseline. Record the current repository state and any existing relevant failures before editing tests.

### 2. Define expected behavior

Use evidence in this order: explicit acceptance criteria and requirements, API/schema contracts and domain invariants, verified examples, then existing tests as supporting evidence. Treat implementation behavior as observation, not automatically as the specification.

Mark claims as confirmed, observed, or assumed. If an unresolved rule changes what a test should assert, record the question and do not encode a guess as a requirement. Test expectations must not be derived solely from the implementation being tested.

### 3. Plan the smallest effective test set

Map each acceptance criterion or risk to one or more scenarios. Inspect architecture and business flows for applicable interaction, state/workflow, reliability/delivery, concurrency/consistency, API/data, identity/security, UI/streaming/batch, and LLM/Agent patterns. Include changed behavior, important unchanged behavior at risk, boundaries, error paths, and regression cases. Reuse or improve existing tests instead of duplicating coverage. Do not force patterns that the project does not use.

Choose the lowest test layer that can prove the behavior:
- **Unit:** business rules, calculations, validation, branching, permissions, and state transitions in isolation.
- **Integration:** real collaboration across persistence, transactions, cache, messaging, authentication, adapters, and external-service boundaries.
- **E2E:** a small number of critical user journeys whose outcome cannot be proven reliably at lower layers.
- **Contract:** compatibility of API, schema, event, or dependency boundaries.
- **Agent / Skill scenario:** observable tool selection and arguments, execution order where required, state changes, generated artifacts, and final task outcome.

Do not add all layers by default. Avoid mocking the behavior or component under test, and avoid tests that only assert that a function was called when a meaningful outcome can be checked.

Write `TEST-PLAN.md` under `<task-workspace>/testing/` before test edits when the task spans multiple layers or business flows, has material risk, or explicitly requests a plan. For a simple focused change, keep the plan in working context instead of creating process paperwork.

### 4. Add or update tests

Change test files, fixtures, and narrowly scoped test-supporting artifacts only. Keep production code and production behavior unchanged.

For a new behavior under active implementation, tests should expose the missing behavior before implementation. For an existing correct behavior that lacks protection, a characterization test may pass against the unchanged implementation. For a regression, first establish a reproducible failing case when possible, then keep the test as a durable guard after the separate implementation workflow fixes the defect.

Assertions must verify externally meaningful behavior, state, outputs, side effects, or contracts. Include negative and boundary cases when they represent plausible failure modes. Do not create tests that always pass, depend on incidental implementation details without reason, or restate the same assertion under many names.

### 5. Execute and expand by risk

Run the narrowest relevant tests first. Then run affected integration or contract tests, broader regression suites, and static checks according to the changed boundary and risk. Run E2E checks when lower layers cannot verify the user-visible path.

Capture actual commands, exit status, pass/fail/skip counts, and actionable failure output. Distinguish tests that passed, failed, were skipped, and were not run. Never infer success from partial logs or an agent's summary.

### 6. Diagnose failures

Classify each relevant failure as one of:
- test defect or invalid assertion;
- production defect or regression;
- environment, dependency, or test-data setup failure;
- pre-existing baseline failure;
- flaky or nondeterministic behavior;
- ambiguous or missing requirement.

Compare with the baseline and inspect the full failure context before assigning cause. A retry without a code change may help identify nondeterminism, but do not silently retry until green. Record the initial failure and each retry; a later pass does not erase a flaky result.

Fix test defects within the agreed scope. Do not patch production code to make tests pass. Report suspected product defects with expected behavior, actual behavior, reproduction evidence, and the smallest useful follow-up.

### 7. Assess test effectiveness

Map acceptance criteria and material risks to tests, and identify uncovered behavior. Coverage data can reveal unvisited code but is not proof of test quality. Where supported and proportionate to risk, use the existing mutation-testing tool or a safe negative control to check whether assertions detect plausible incorrect behavior. Do not introduce a new mutation-testing dependency or modify production code merely to manufacture a failure.

For Agent / Skill tests, prefer deterministic checks of tool traces, parameter schemas, state changes, exit status, and artifacts. Treat free-form LLM output with explicit semantic criteria or a recorded evaluator, not brittle whole-string matching. Separate deterministic regression tests from live-model evaluations, and report model, configuration, sample size, and variability when those evaluations are run.

### 8. Report evidence

For non-trivial test work, save `TEST-REPORT.md` under `<task-workspace>/testing/`. If no task workspace exists, use `/tmp/afk-testing/<repository-slug>/<task-slug>/`; do not place generic planning or report files in the repository root. For a small task, provide the same essential summary directly without creating unnecessary files.

The report must include:

| Layer | Added | Updated | Reused | Passed | Failed | Skipped | Not run |
|---|---:|---:|---:|---:|---:|---:|---:|
| Unit | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Integration | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E2E | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Other applicable layers | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Total** | **0** | **0** | **0** | **0** | **0** | **0** | **0** |

Use actual counts. Separate test-case changes from execution outcomes, and do not count retries as new cases.
- scope and expected behavior tested;
- test-case counts by unit, integration, E2E, and other applicable layers;
- added, updated, and reused cases separately from execution outcomes;
- commands actually run and their real results;
- baseline failures, new failures, flaky results, and checks not run;
- test-quality evidence, if evaluated;
- uncovered risks, assumptions, deviations, and production defects requiring follow-up.

Count distinct test cases, not files, assertions, or repeated runs. Follow the project's conventions for parameterized cases; when a count cannot be determined, mark it unknown rather than guessing. Do not report a test as passed if it was not executed.

## Completion criteria

- The test scope and expected behavior are evidence-based and bounded.
- Relevant scenarios have meaningful assertions and an explicit relationship to acceptance criteria or risks.
- Actual test execution results are captured; skipped and unrun checks remain visible.
- Failures are classified against the baseline and not hidden by retries.
- No production code or business behavior was changed.
- The result states what is verified, what is not verified, and what needs a separate implementation or human decision.

## Caveats

- MUST NOT fix production defects or implement feature code under this skill.
- MUST NOT weaken assertions, delete failing tests, or skip checks merely to produce a green result.
- MUST NOT treat current behavior, line coverage, or an AI-generated explanation as sufficient proof of correctness.
- MUST NOT replace real boundary verification with mocks of every dependency.
- MUST NOT claim test execution, coverage, mutation results, or Agent success without actual evidence.
- MUST NOT replace the independent `afk-qa` gate for managed backlog work.
