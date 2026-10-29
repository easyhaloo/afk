---
name: afk-to-issues
disable-model-invocation: true
description: >-
  Analyze approved requirements and one or more target repositories, then
  decompose the required changes into a provider-neutral backlog manifest
  with traceable acceptance criteria, cross-repository dependencies, execution
  modes, and business tags. This skill drafts and validates the handoff; the
  configured backlog provider creates the records.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# Requirements -> Backlog Manifest

**Goal:** Produce independently executable backlog items that collectively
deliver an approved requirement, with verifiable completion conditions.
A PRD may span one repository or multiple repositories. The output is a
provider-neutral manifest; the configured external backlog system creates
the records.
**Mode:** HITL-gated — analyze and draft first, obtain explicit approval,
then emit the approved manifest.

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
- key: <stable draft-local key, e.g. task-api-upload>
  title: <short outcome-oriented title>
  description: <context and intended outcome>
  targetRepository: <canonical repository identifier or configured alias>
  baseRef: <explicit ref or inherit configured default>
  parentId: <stable draft reference or null>
  baseBacklogId: <provider backlog id used as Git execution base, or null>
  dependsOn: [<stable draft keys or existing backlog ids>]
  executionMode: afk | hitl
  tags: [<business tags>]
  changeScope:
    inScope: [<confirmed intended changes>]
    outOfScope: [<explicit non-goals>]
  sourceRequirements: [<PRD requirement / AC / BR IDs>]
  acceptanceCriteria:
    - text: <observable condition>
      evidenceType: test | curl | log | manual | none
      checkCommand: <concrete verification command>
```

`targetRepository` is manifest/control-plane metadata used by the provider to
create the issue in the correct repository; it is not duplicated in the Issue
body because the Issue already belongs to its repository. For an ambiguous
repository alias, resolve it to a canonical repository identity before
approval. Never silently choose a repository based only on a similar name.

`baseRef` may inherit a configured repository default when no special version
constraint exists. Use an explicit branch/tag when the PRD requires a release
line or compatibility target. Resolve and record the actual base commit SHA
when execution starts; do not invent a SHA during planning. The work branch is
created by the execution workflow and usually does not need to be hard-coded
in the Issue body.

`key` is stable only within the draft and supports dependency references
before provider IDs exist. The provider resolves draft keys to canonical item
IDs. `parentId` is organizational; `dependsOn` controls scheduling.
`baseBacklogId` selects an unmerged Git execution base only when supported by
the provider/runtime. Do not confuse issue identity, execution `runId`, and
Git commit SHA.

The Issue body should use `references/issue-template.md`. Keep repository
identity in manifest metadata, not in the body. The body should clearly state
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
Assign each task a target repository, scope, non-goals, source requirement IDs,
base-ref policy, verification, and cross-repository dependencies. Prefer
single-repository tasks; justify exceptions. Use stable draft keys until the
provider assigns IDs.

### 4. Self-quality gate

Check:

- Every in-scope PRD requirement is covered or explicitly blocked with a reason.
- No task introduces unconfirmed product behavior.
- Every task has a known target repository and grounded change scope.
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

### 6. Emit handoff

After approval, write the provider-neutral manifest and PRD reference to the
requested artifact location. The configured backlog provider/importer creates
the records in their respective repositories and resolves draft keys to
canonical IDs. Do not claim creation succeeded unless the provider reports
success and the created records and relationships have been read back and
verified.

## References

- `references/multi-repository-analysis.md`: required repository discovery,
  evidence, and cross-repository coordination workflow.
- `references/ddd-slicing.md`: bounded-context and vertical-slicing rules.
- `references/issue-template.md`: Issue body structure and acceptance criteria.

## Caveats

- Never create provider records before the approval gate.
- Never include repository identity in the Issue body solely to repeat the
  repository association; carry the target in manifest metadata.
- Never claim repository analysis is complete when a relevant repository was
  inaccessible.
- Do not turn inferred technical details into new product requirements.
- Keep the global dependency graph acyclic and explain unresolved external
  references for the importer.
