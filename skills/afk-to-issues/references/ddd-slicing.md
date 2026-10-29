# DDD-Aware Backlog Slicing

**Purpose:** Slice approved requirements into independently executable work
items using business outcomes, bounded contexts, repository boundaries, and
real delivery dependencies.
**When:** After the mandatory repository analysis in `SKILL.md`.
**Output:** A provider-neutral manifest whose items collectively cover the
approved PRD and whose dependencies form one global DAG, including across
repositories.

---

## Core Principle

**Prefer vertical business slices; use repository and bounded-context
boundaries to plan implementation, not as automatic reasons to split.**

A bounded context is a domain boundary. A repository is a code ownership and
deployment boundary. They are not necessarily one-to-one:
- One bounded context may be implemented across several repositories.
- One repository may contain multiple bounded contexts.
- A single user-visible outcome may require coordinated changes across
  repositories.

Do not split every PRD story into frontend/backend/database tasks merely
because those layers live in different repositories. Split only when the
resulting items have clear deliverables, verifiable acceptance, and a real
dependency or ownership reason.

## Slicing Rules

### Rule 1 — Prefer an independently verifiable outcome

A task should deliver a coherent business behavior or a concrete prerequisite
with its own acceptance criteria. Include the necessary model, API/logic, and
tests within the target repository when that makes the outcome independently
verifiable.

### Rule 2 — One target repository per task by default

Each task normally targets one repository, enabling a clear base version,
branch, diff boundary, and execution environment. The manifest records
`targetRepository`; the Issue body does not repeat the repository name.

A task may span repositories only when splitting it would create artificial
work items that cannot be independently implemented or verified. Such an
exception must list every repository, its intended changes, base-ref policy,
coordination constraints, and cross-repository verification. Prefer separate
tasks linked by dependencies whenever the boundaries are real.

### Rule 3 — Split on real boundaries

Separate tasks when there is a meaningful difference in:
- Bounded context or ownership.
- Independent acceptance or release boundary.
- API, schema, event, or generated-client contract.
- Migration, rollout, or compatibility requirement.
- Risk, environment, credential, or isolation needs.
- A prerequisite that can be completed and verified independently.

Do not create a separate task for a model, API, or method merely because it
exists as a separate technical layer.

### Rule 4 — Model cross-repository contracts explicitly

When a producer repository changes an API, schema, event, or generated
contract consumed by another repository:
- Identify producer and consumer tasks.
- Record the contract version and compatibility requirements.
- Make consumers depend on producer contract readiness when necessary.
- Prefer backward-compatible rollout sequences where supported.
- Include integration/contract tests that validate both sides.
- Avoid circular dependencies; if the work is truly coordinated, introduce
  a separately verifiable compatibility/prerequisite task or ask for a
  sequencing decision.

A repository dependency must not be inferred from repository names alone.

### Rule 5 — Keep one global dependency DAG

Dependencies may cross repository boundaries. Use stable draft-local keys
until the backlog provider assigns canonical IDs. Check for cycles across the
entire PRD task graph, not separately per repository. Identify independent
tasks that can run in parallel, while flagging shared contracts or files that
could cause conflicts.

### Rule 6 — Parent and dependency are different

Parent/child relationships organize work. `dependsOn` expresses a real
execution prerequisite. Do not use parent links as a substitute for
dependencies, and do not make every child depend on its parent unless the
runtime contract explicitly requires that behavior.

### Rule 7 — Acceptance must prove the intended behavior

Each task must have:
- Observable, bounded acceptance criteria.
- A concrete verification method based on repository evidence.
- Source requirement IDs from the approved PRD.
- Explicit non-goals to prevent scope creep.
- Cross-repository integration verification when independent tests are
  insufficient.

A successful shell command is not itself proof that the product behavior is
correct. Human checks remain pending until a human signs them off.

---

## Example: One PRD, Three Repositories

PRD: “A user can upload a file and see a reliable result.”

| Draft key | Target repository | Deliverable | Depends on |
|---|---|---|---|
| `storage-upload` | `file-storage` | Persist file content and metadata with defined failure behavior | none |
| `api-upload` | `file-api` | Validate request, authorize user, call storage, expose stable response contract | `storage-upload` only if its contract is required first |
| `web-upload` | `web-app` | Upload interaction and success/error feedback against the agreed API contract | `api-upload` when the contract is not already stable |
| `upload-e2e` | configured integration-test repository, or one suitable existing repository | Verify upload success, rejection, and error propagation across the integrated flow | relevant producer/consumer tasks |

This is illustrative, not a mandatory four-task plan. If storage and API already exist,
reuse them; if contract tests live with the API, do not invent a separate test
repository. The actual task count and dependencies must come from repository
evidence.

## Slicing Checklist

Before approval, confirm:

- [ ] The full repository set relevant to the PRD has been identified, or access
      limitations are explicit.
- [ ] Each requirement is mapped to evidence and one or more candidate
      repositories.
- [ ] Each task has a clear target repository, base-ref policy, change scope,
      non-goals, and verification.
- [ ] Repository boundaries have not replaced business-outcome reasoning.
- [ ] Cross-repository contracts, rollout constraints, and consumers are
      represented in the global DAG.
- [ ] The global DAG is acyclic and parallel work is identified.
- [ ] End-to-end behavior is verified where repository-local tests are
      insufficient.
- [ ] No new product behavior was inferred from code structure alone.

## Anti-Patterns

- Splitting every PRD story into frontend/backend/database tickets by default.
- Assuming one bounded context equals one repository.
- Assuming a repository is relevant based only on its name.
- Omitting consumer dependencies for a breaking contract change.
- Treating independent repository tests as proof of end-to-end integration.
- Creating an issue in a repository that was never confirmed as a target.
- Making repository identity a duplicated Issue-body field instead of manifest
  metadata.
