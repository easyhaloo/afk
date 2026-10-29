---
name: afk-to-issues
disable-model-invocation: true
description: >-
  Analyze approved requirements and one or more target repositories, then
  decompose the required changes into a provider-neutral backlog manifest
  with traceable acceptance criteria, cross-repository dependencies, execution
  modes, and business tags. After explicit approval, it creates and verifies
  records through the AFK CLI.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# Requirements -> Backlog Manifest

**Goal:** Produce independently executable backlog items that collectively
deliver an approved requirement, with verifiable completion conditions.
A PRD may span one repository or multiple repositories. The manifest is
provider-neutral; after approval, the AFK CLI creates and verifies the
backlog records in their target repositories.
**Mode:** HITL-gated — analyze and draft first, obtain explicit approval,
then create records through the AFK CLI.

## Backlog/commit boundary

The backlog item is the user-facing issue, so its `title` and `description`
must describe the problem or intended outcome before implementation. Do not
reuse a Conventional Commit title such as `fix(qa): ...` or paste a commit
body into the issue description. Commit type/scope, Progress checklists,
`Next:` trailers, `Refs #...`, and `Co-Authored-By` belong to Git history
after implementation and are generated separately.

## Mode decision

| Input | Use |
|---|---|
| Approved PRD with user stories / observable behaviors | PRD Mode |
| Aligned requirement context without a PRD | Direct Mode |

Choose `executionMode` per item: `afk` for deterministic, automatable work;
`hitl` when a human decision, manual check, or non-automatable action is
required. Use business tags only (for example `frontend`, `security`, or
`needs-isolation`); never encode state or execution mode in tag names.

## Mandatory repository analysis

Read `references/multi-repository-analysis.md` before decomposing a PRD.
Repository analysis is required even when the user names only one repository.

1. Establish the target repository set from explicit user context, workspace
   configuration, PRD references, and relevant repository links. Search for
   related repositories when access and tools allow.
2. Confirm each candidate repository is accessible and relevant. Inspect its
   purpose, default branch, current Git state when a local checkout is
   available, project instructions, architecture/module boundaries, related
   implementation, API/schema/event contracts, tests, and existing open
   backlog items. Analyze relevant areas deeply; do not read every file
   indiscriminately.
3. Build a requirement-to-repository map. For each requirement, classify the
   observed implementation as `reuse`, `extend`, `add`, `migrate`, or
   `unknown`; cite concrete files, symbols, tests, or configuration as
   evidence when available.
4. Record cross-repository contracts and coordination needs, including
   producers/consumers, API or schema compatibility, rollout order, and
   integration verification.
5. Do not infer that a capability is absent merely because a search did not
   find it. Use `not found` / `unknown` until evidence supports a conclusion.
6. Do not invent product behavior to resolve implementation gaps. If an
   unresolved fact changes user-visible behavior, scope, compatibility, or
   acceptance, pause affected decomposition and ask for clarification.

If a repository cannot be accessed, report the repository and the missing
evidence. Do not silently omit it or claim the cross-repository plan is
complete. Continue with unaffected analysis only when useful, and mark the
plan as blocked or partial.

## Change analysis before slicing

Create an internal Change Analysis before drafting issues. It must include:

- Confirmed PRD requirement IDs and acceptance criteria.
- Target repositories and the evidence for each mapping.
- Existing capability and planned change: reuse, extend, add, migrate, unknown.
- Expected change scope and non-goals per repository/task.
- Cross-repository contracts, risks, dependencies, and rollout constraints.
- Verification strategy, including cross-repository integration checks.
- Open questions and unavailable evidence.

This analysis is the basis for task decomposition; it is not automatically a
new Issue. Keep product requirements from the PRD separate from technical
findings inferred from repository inspection.

## Slice strategy

1. Prefer independently verifiable vertical slices that deliver a coherent
   business outcome.
2. Repository boundaries are implementation/ownership constraints, not
   product boundaries. Do not split one business outcome into frontend,
   backend, and database issues solely because they live in different
   directories or repositories.
3. A single task should normally target one repository so an agent can use
   one checkout, base version, branch, and diff boundary. If a change truly
   requires coordinated edits in multiple repositories and cannot be split
   into independently verifiable tasks, explicitly justify the exception,
   enumerate every repository and scope, and define cross-repository
   verification.
4. Split by real delivery dependencies, API/schema/event contracts, bounded
   contexts, migration needs, ownership, or independent acceptance boundaries.
   Use horizontal prerequisite tasks for shared infrastructure, migrations,
   contract publication, or cross-cutting refactors only when they have a
   concrete deliverable and verification.
5. Bounded context and repository are different concepts: a context can span
   multiple repositories, and a repository can contain multiple contexts.
   Use the actual dependency and domain model rather than assuming a one-to-one
   mapping.
6. Avoid fixed line-count/module-count thresholds as the sole split trigger.
   Consider independent value, scope clarity, risk, verification, dependency,
   and execution cost.
7. Explain the chosen slicing strategy. Build one global dependency DAG across
   all repositories, then check for cycles and identify parallelizable tasks.

## Verification inference

For each observable behavior or requirement clause, inspect the repository to
infer a real verification signal:

1. What proves the behavior — test runner, HTTP assertion, log, artifact, or
   human inspection.
2. The `evidenceType`: `test` | `curl` | `log` | `manual` | `none`.
3. A concrete `checkCommand` that exits 0 on PASS and does not mutate state.

A command exiting 0 proves only that the command passed, not necessarily that
the product behavior is correct. Do not use `echo` or another always-success
placeholder as proof of acceptance. For `manual`, explicitly state the human
check and leave it pending until sign-off. Use `none` only when no runtime
behavior should exist (for example, a verified removal/refactor property),
and provide a meaningful static check where possible.

Cross-repository changes must include contract-level or end-to-end verification
where applicable; independent repository tests alone may not prove that the
integrated capability works.

## Backlog item contract

Emit one manifest entry per item with these provider-neutral fields:

```yaml
- title: <short outcome-oriented title>
  description: <context, outcome, change scope, acceptance criteria, verification, traceability>
  project: <canonical project key, platform:projectKey>
  ref: <stable local name other items can point at>
  parentId: <provider backlog id, manifest ref, or null>
  baseBacklogId: <provider backlog id used as the Git base, or null>
  dependsOn: [<provider backlog ids or manifest refs>]
  executionMode: afk | hitl
  tags: [<business tags>]
```

`project` names the repository the item belongs to, as a canonical project
key: `platform:projectKey`, for example `github:acme/api` or
`gitlab:gitlab.example.com/group/service`. It is control-plane metadata: the
provider uses it to create the issue in the correct repository, and the body
does not repeat it because the issue already belongs to that repository. For
an ambiguous repository alias, resolve it to a canonical project key before
approval. Never silently choose a repository based only on a similar name. A
requirement that spans repositories has its items in the repositories that
own them, so give every item the project that owns the work. Omit it only
when the whole manifest belongs to one repository, and let the provider apply
it there.

`ref` is a name other items of the same manifest can point at. Use it when
an item waits for, hangs under, or starts from another item of the same
decomposition. Give each item a `ref` that says what it is, not a number:
`kbase-route`, `atlas-endpoint`. A `ref` is stable only within the draft;
the provider resolves draft references to canonical item IDs.

`parentId`, `dependsOn`, and `baseBacklogId` are references. A reference is
either the canonical ID of a record that already exists, or the `ref` of
another item of this manifest. Parents are organizational and are not
runnable. Dependencies control scheduling. Every dependency must be complete
before an `afk` item can be claimed. The provider assigns the canonical ID
and initial state; do not invent state labels in this manifest.

Only `baseBacklogId` selects an unmerged Git execution base. Omit it to
inherit the target repository's configured base branch, and name it when the
item starts from an unmerged record of the same repository. A base in another
repository is still recorded for traceability, but a branch there is not a
valid Git baseline for this checkout, so execution uses the target
repository's configured branch. Resolve and record the actual base commit SHA
when execution starts; do not invent a SHA during planning. The work branch
is created by the execution workflow and usually does not need to be
hard-coded in the issue body. Do not confuse issue identity, execution
`runId`, and Git commit SHA.

The issue body is the manifest item's `description`, and it should use
`references/issue-template.md`. Keep repository identity in manifest
metadata, not in the body. The body should clearly state
objective/context, base-version constraints when relevant, change scope,
out-of-scope items, acceptance criteria, verification, dependencies, and
requirement traceability.

## Steps

### 1. Select mode and read inputs

Determine PRD or Direct Mode. Read the complete approved requirement artifact.
Extract stable requirement IDs where available. If the PRD lacks stable IDs,
assign draft-local IDs without changing the approved PRD.

### 2. Discover and analyze repositories

Follow the mandatory repository-analysis workflow and read
`references/multi-repository-analysis.md`. Confirm access, inspect relevant
code and existing backlog, and produce the Change Analysis. Do not start
decomposition until the repository map is sufficiently grounded or the plan
explicitly records an access limitation.

### 3. Slice and compose drafts

Create candidate tasks from confirmed requirements and the Change Analysis.
Assign each task its project, scope, non-goals, source requirement IDs,
execution base, verification, and cross-repository dependencies. Prefer
single-repository tasks; justify exceptions. Use stable draft keys until the
provider assigns IDs.

### 4. Self-quality gate

Check:

- Every in-scope PRD requirement is covered or explicitly blocked with a reason.
- No task introduces unconfirmed product behavior.
- Every task has a known project and grounded change scope.
- No duplicate, orphan, unjustified oversized, or implementation-only task.
- Dependencies reference valid items, form an acyclic global DAG, and reflect
  real contract/delivery constraints.
- Cross-repository producers and consumers agree on the relevant contract.
- Acceptance checks are meaningful, non-mutating, and do not mistake command
  success for product acceptance.
- Existing backlog items are reused or linked where appropriate, not duplicated.
- Parallel tasks have compatible repository/branch assumptions and do not
  unknowingly edit the same shared contract.

### 5. HITL approval

Present the Change Analysis summary and all proposed tasks. Show target
repository for each task, intended scope, non-goals, source requirement IDs,
dependencies across repositories, contract/rollout risks, verification, and
unresolved questions. Wait for explicit approval. On revision, update the plan
and repeat the quality gate.

### 6. Create and verify through the AFK CLI

After explicit approval, preserve the approved manifest as an audit/recovery
artifact and create the records through the AFK CLI; do not stop at emitting
a manifest or ask the user to manually import/apply it.

1. Read the installed CLI's `afk backlog apply-manifest --help` and confirm
   the supported options before invoking it. Every item names the project it
   belongs to; never rely on the current working directory to choose a
   repository in a multi-repository plan.
2. Validate the complete draft DAG locally before creating anything: every
   reference must resolve, the graph must be acyclic, and every project must
   be canonical. Run `afk backlog apply-manifest <file> --dry-run` first and
   read the plan it prints.
3. Apply the same manifest without `--dry-run`. The provider creates the
   records in the order the plan decided and writes the relationships between
   them, so an item that waits for another one is created after it. Pass
   `--idempotency-key <prefix>` so a retry returns the records that already
   exist instead of creating them twice.
4. Use canonical cross-project item identities for `parentId`,
   `baseBacklogId`, and `dependsOn`. Do not assume bare issue numbers are
   globally unique. Cross-repository `baseBacklogId` references are allowed;
   however, a branch in another repository cannot be used as the Git base for
   the target checkout. Runtime preserves that reference for traceability and
   uses the target repository's configured base branch in this case. Use
   `dependsOn` separately when completion ordering is required.
5. After creation, read every created item back using the CLI and verify its
   target project, title/body, execution mode, tags, parent/dependency links,
   and returned URL. Validate the global graph against the approved plan.
6. Save a creation ledger containing plan identity, draft key, target project,
   canonical item ID, URL, creation result, and verification result. On partial
   failure, resume from verified ledger entries and reuse idempotency keys;
   do not recreate successful items or pretend the whole plan succeeded.

If the CLI, credentials, target repository, or provider cannot support a
required operation, stop and report the exact blocker. Never claim creation
succeeded without provider confirmation and read-back verification.

## References

- `references/multi-repository-analysis.md`: required repository discovery,
  evidence, and cross-repository coordination workflow.
- `references/ddd-slicing.md`: bounded-context and vertical-slicing rules.
- `references/issue-template.md`: Issue body structure and acceptance criteria.

## Caveats

- Never create backlog records before the approval gate.
- Never include repository identity in the issue body solely to repeat the
  repository association; the item's `project` says where the record belongs.
- Never claim repository analysis is complete when a relevant repository was
  inaccessible.
- Do not turn inferred technical details into new product requirements.
- Keep the global dependency graph acyclic; resolve draft `ref`s to canonical
  identities during topological creation.
- Treat a partial multi-repository creation as partial until all records and
  relationships have been verified.
