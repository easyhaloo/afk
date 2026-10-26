---
name: afk-change-driven-testing
description: >-
  Plans and adds focused regression tests for the business flow affected by a
  current code change. Use when modifying existing business logic, fixing a
  bug, or extending a legacy flow with missing or weak unit, integration, or
  E2E coverage. Uses parallel read-only exploration and a scoped TEST-PLAN.md;
  not for repository-wide test-coverage projects.
---

# Change-Driven Testing

**Goal:** Make each code change add a small, evidence-based increment of regression protection for the affected business behavior, without expanding into unrelated coverage work.

## Workflow

### 1. Establish the task workspace and artifact names

Reuse the task/work-item workspace if one already exists. Store artifacts under `<task-workspace>/testing/`. If no task workspace exists, create a task-specific workspace using the repository's established convention; do not invent a competing convention or place generic test-planning files in the repository root.

Use these stable names:
- `TEST-ANALYSIS.md` — consolidated exploration evidence, existing coverage, gaps, assumptions, and conflicts.
- `TEST-PLAN.md` — approved scope and test plan; must exist before test implementation begins.
- `TEST-REPORT.md` — test-case counts by layer, commands and actual results, deviations, and remaining risks.

Always produce `TEST-PLAN.md`. Produce `TEST-ANALYSIS.md` when the task benefits from a durable analysis record. Produce `TEST-REPORT.md` when test changes or execution results need a durable record; for simple changes, keep it concise. When reporting test changes, always state the number of test cases added and updated, broken down by unit, integration, and E2E. Never create one file per subagent: merge findings into the shared artifacts.

### 2. Explore in parallel with subagents

Before changing production code or tests, identify the changed behavior and dispatch independent, read-only exploration tasks to subagents when subagent support is available. Prefer parallel work for:
- **Business-flow explorer:** trace entry points, callers/callees, state transitions, business invariants, and downstream effects.
- **Test-coverage explorer:** locate relevant unit/integration/E2E tests, fixtures, commands, conventions, and gaps in assertions.
- **Boundary-and-risk explorer:** inspect affected persistence, APIs, messaging, permissions, external adapters, error paths, and plausible regressions.

Give each subagent a narrow question, the target scope, and an explicit read-only constraint. Ask for findings with file/line evidence, confirmed facts vs. assumptions, relevant tests, and unresolved questions. Do not ask all workers to inspect the entire repository.

Parallelize independent discovery, not conflicting edits. The main agent owns task coordination, requirement interpretation, conflict resolution, artifact writing, implementation, and final verification. Subagents must not independently edit shared artifacts, production code, or the same tests during exploration. If subagents are unavailable, perform the same explorations sequentially and note that fallback only when relevant.

### 3. Synthesize findings and define expected behavior

Read the relevant source and existing tests yourself; treat subagent findings as evidence to verify, not unquestionable truth. Trace the flow only far enough to identify meaningful boundaries, state changes, data writes, and external effects.

Derive expected behavior from acceptance criteria, domain rules, API contracts, invariants, and confirmed examples. Distinguish:
- **Confirmed requirement** — supported by an explicit source.
- **Observed behavior** — what the current implementation does, not necessarily what it should do.
- **Assumption / open question** — not yet confirmed.

Do not encode a suspected legacy bug as desired behavior. Ask the user only when an unresolved business rule changes the expected result or implementation direction.

### 4. Write `TEST-PLAN.md` before implementation

Consolidate exploration into `TEST-ANALYSIS.md` when useful, then write `TEST-PLAN.md` before adding or changing tests. The plan must define the boundary of this task, not a repository-wide testing roadmap.

Use this structure:

```markdown
# Change-Driven Test Plan: <task-id>

## Change Summary
## Affected Business Flow
## Existing Test Protection
## In-Scope Test Cases
| ID | Behavior / Scenario | Layer | Expected Result | Evidence | Status |
## Explicitly Out of Scope
## Assumptions and Open Questions
## Validation Commands and Acceptance Criteria
## Risks Not Covered
```

Every proposed test case must identify the behavior, expected result, and evidence source. Include the changed rule, important unchanged behavior at risk, relevant boundary/error paths, and regression scenarios tied to this flow. Mark existing tests to reuse/update rather than duplicating them. State why a layer is selected. Explicitly list adjacent but excluded work so the scope can be reviewed.

If investigation changes the scope, update `TEST-PLAN.md` before proceeding with the newly discovered work. Do not silently broaden the task. If a requirement is blocked on user clarification, record it and pause only the affected decision.

### 5. Choose the lowest effective test layer

- **Unit:** business rules, calculations, validation, permissions, branching, and state transitions in isolation.
- **Integration:** collaboration across real boundaries such as transactions, persistence, cache, messaging, authentication, and external-service adapters.
- **E2E:** a small number of critical user journeys when component-level tests cannot prove the required end-to-end outcome.

Do not add all three layers by default. Do not mock the component or behavior under test. Prefer the smallest test set that would catch plausible regressions at the changed boundary.

### 6. Implement the planned test increment

Follow the repository's test conventions and existing implementation workflow. For a new or changed rule, write/update the focused test before implementation when practical. For an existing untested flow, first add characterization tests for confirmed behavior, then change the behavior under test. If production code has already changed, derive assertions from requirements and independent evidence rather than copying the implementation.

Keep changes within `TEST-PLAN.md`. If a new risk warrants more tests, update the plan first. Do not let multiple subagents edit the same files concurrently. Parallel implementation is allowed only for clearly disjoint files/tasks with explicit ownership and a main-agent integration step.

### 7. Run and diagnose

Run new tests and the narrowest relevant regression suite. Expand to broader suites when shared contracts, state, persistence, or downstream behavior could be affected. Classify failures as test defects, product defects, environment failures, pre-existing failures, or unresolved requirements.

Never weaken assertions, skip tests, or alter unrelated production behavior just to get a green result. Never claim a command passed unless it was actually run; mark unexecuted checks clearly.

### 8. Report the increment

Write/update `TEST-REPORT.md` when test changes or execution results need a durable record. Include a test-case count summary broken down by layer, using actual test cases rather than counting test files or assertions:

```markdown
## Test Case Summary
| Test Layer | Added | Updated | Reused (not changed) | Passed | Failed | Not Run |
|---|---:|---:|---:|---:|---:|---:|
| Unit | 0 | 0 | 0 | 0 | 0 | 0 |
| Integration | 0 | 0 | 0 | 0 | 0 | 0 |
| E2E | 0 | 0 | 0 | 0 | 0 | 0 |
| **Total** | **0** | **0** | **0** | **0** | **0** | **0** |
```

Count each distinct test case once per category; do not count test files, assertions, parameterized cases, or test runs as separate cases unless the project's test conventions treat them as distinct cases. If a test's layer or count cannot be determined, mark it as unknown rather than guessing. Separate added/updated/reused counts from execution outcomes, and do not imply that an unrun test passed.

Also summarize:
- affected flow and final scope;
- commands actually executed and their results;
- deviations from `TEST-PLAN.md` and why they were necessary;
- remaining risks, unexecuted checks, and separate follow-up debt.

Do not fix unrelated test debt in this task.

## Completion Criteria

- `TEST-PLAN.md` was created before test implementation and clearly defines in-scope and out-of-scope work.
- The changed business behavior has explicit, meaningful assertions.
- Important adjacent behavior at risk has regression protection or a documented reason for exclusion.
- Subagent findings were synthesized and conflicts resolved by the main agent; no conflicting parallel edits remain.
- Tests run in the project-supported environment, with unexecuted checks clearly marked.
- Remaining uncertainty and uncovered risk are visible to the developer.
- Test reporting distinguishes added, updated, and reused cases, with counts and execution outcomes broken down by unit, integration, and E2E.

## Caveats

- MUST NOT use line coverage alone as proof of test quality.
- MUST NOT assume current behavior is the correct specification.
- MUST NOT generate tests that only assert a call occurred or that always pass.
- MUST NOT replace real integration verification with mocks of every dependency.
- MUST NOT introduce broad abstractions or production refactors solely to make tests easier without demonstrating the need.
- MUST NOT create unrelated tests for untouched modules unless the current change puts their behavior at risk.
- MUST NOT allow parallel subagents to independently expand scope or edit shared files during exploration.
