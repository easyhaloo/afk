# Multi-Repository Analysis

**Purpose:** Determine which repositories must change to deliver one approved
PRD and gather enough evidence to create grounded, correctly scoped issues.
This analysis is mandatory in `afk-to-issues`, including when only one target
repository is expected.

## 1. Establish repository scope

Discover candidate repositories from, in priority order:

1. Explicit user-selected repository/workspace configuration.
2. Links and repository references in the approved PRD or alignment record.
3. Local workspace manifests, project instructions, submodules, and related
   service/client references.
4. Existing issues, PRs, API definitions, generated clients, deployment
   manifests, and documentation that point to related repositories.
5. Repository search, if a connected tool is available and permitted.

Do not treat every repository found in an organization as relevant. For each
candidate, record why it is included or excluded. A repository name alone is
not evidence that it owns a capability.

If access is unavailable, record the exact repository and missing evidence.
Do not silently drop it. Mark affected scope as partial/blocked and ask for
access or a decision when that limitation could change the plan.

## 2. Inspect each relevant repository

Use targeted inspection, not a blind full-repository read. Inspect as relevant:

- Repository purpose, default branch, release branches, and current ref.
- Working-tree state and existing user changes when a local checkout is
  available; never overwrite or reset user changes.
- Project-level agent instructions and engineering conventions.
- Relevant modules, entry points, call graphs, data models, APIs, schemas,
  events, configuration, deployment and migration logic.
- Existing tests, test commands, fixtures, contract tests, and integration
  environments.
- Open issues, PRs, existing backlog items, and in-progress work that may
  already cover the requirement.
- ADRs or documented compatibility/security constraints.

Record concrete evidence such as paths, symbols, tests, contracts, or existing
backlog URLs. Distinguish facts from hypotheses.

## 3. Map requirements to repositories

For every approved requirement / acceptance criterion, create an internal map:

| Requirement ID | Repository | Existing evidence | Assessment | Expected change |
|---|---|---|---|---|
| `FR-001` | `web-app` | path/symbol/test | reuse / extend / add / migrate / unknown | grounded scope |

Assessment meanings:

- **reuse** — existing capability appears to satisfy the confirmed behavior;
  verify the acceptance rather than creating duplicate work.
- **extend** — existing capability needs a bounded change.
- **add** — evidence supports that the required capability needs to be built.
- **migrate** — behavior/data/contracts must move or change with a migration plan.
- **unknown** — evidence is insufficient; investigate or ask.

Use “not found” rather than “does not exist” when search coverage is incomplete.
Never create a task merely because the requirement text mentions a technical
layer.

## 4. Analyze cross-repository contracts

For every interaction between repositories, identify when applicable:

- Producer and consumer.
- API, schema, event, shared type, generated client, or storage contract.
- Compatibility requirements and whether old and new versions can coexist.
- Required rollout order, feature flags, migrations, and rollback concerns.
- Contract tests and integrated end-to-end verification.
- Shared files, generated artifacts, or release coupling that may block
  parallel work.

Create dependency edges only when a real prerequisite exists. A producer/consumer
relationship does not automatically require a strict issue dependency if the
contract is already stable and compatible.

If two tasks create a dependency cycle, do not emit a cyclic graph. Explore
backward-compatible sequencing or a separate contract/prerequisite task. If
the cycle reflects an unresolved product or architecture decision, ask before
approval.

## 5. Derive change scope and task boundaries

For each proposed task, define:

- One target repository by default.
- Base-ref policy: inherit the repository default unless a confirmed release or
  compatibility constraint requires a specific ref.
- In-scope modules/behaviors and the evidence supporting them.
- Explicit out-of-scope changes.
- Repository-local tests and any cross-repository contract/integration checks.
- Source PRD requirement and acceptance IDs.
- Dependencies, rollout risks, and isolation needs.

Prefer a vertical slice with one coherent outcome. Use separate repository
tasks where each has an independently meaningful deliverable; use a horizontal
prerequisite only for a real shared capability, migration, contract, or
infrastructure need. A multi-repository task is an exception and must explain
why the work cannot be split without losing coherent verification.

## 6. Validate coverage and consistency

Before issue creation, verify:

- Every in-scope requirement maps to a task or is explicitly blocked/reused with
  evidence.
- No task lacks a confirmed goal, target repository, scope, or verification.
- No two tasks duplicate the same change without an explicit coordination
  reason.
- Cross-repository contracts have consistent assumptions.
- The global dependency graph is acyclic.
- Parallel tasks do not unknowingly compete over the same contract, migration,
  generated file, or release branch.
- Existing issues are linked/reused instead of duplicated.
- End-to-end acceptance is covered when repository-local tests are insufficient.
- Unknowns that could alter product behavior are sent for clarification rather
  than silently decided by the agent.

## 7. Approval output

Present a concise summary, not a dump of every inspected file:

1. Repository map and reason each repository is in scope.
2. Requirement-to-repository coverage.
3. Reuse/extend/add/migrate findings and key evidence.
4. Proposed tasks with target repository, scope, non-goals, and verification.
5. Global dependency DAG and parallelizable groups.
6. Cross-repository contracts, rollout risks, and integration checks.
7. Open questions, inaccessible repositories, and assumptions requiring approval.

The approved plan is then converted into manifest entries. Repository identity
is stored as manifest metadata so the provider can create each issue in the
right repository; it is not repeated in the Issue body.
