---
name: afk-to-issues
disable-model-invocation: true
description: >-
  Decompose an approved PRD into executable, verifiable child backlog items by
  inspecting repository evidence, selecting a slicing strategy, building
  relationships, and using AFK CLI to create records with traceable URLs.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# PRD -> AFK Child Backlogs

**Goal:** Transform an approved PRD into independently executable and
verifiable child backlogs under its root backlog. The PRD defines **what** must
be achieved; this skill determines **how the work should be organized** without
inventing requirements.

**Mode:** HITL-gated — analyze and draft first, obtain explicit approval, then create the approved backlog through AFK.

## Workflow

1. **Read the published PRD** — preserve scope, acceptance criteria, decisions, risks, and unresolved questions.
2. **Inspect repository evidence** — examine relevant code, tests, architecture, ADRs, conventions, and existing backlog items. Identify reusable components and the actual change surface before decomposing work.
3. **Build the execution model** — identify capabilities, technical foundations, ownership boundaries, verification boundaries, dependencies, and work that can run in parallel.
4. **Decompose tasks** — create coherent work units that can be independently executed and verified. Prefer vertical slices for business capabilities; use horizontal slices for foundations, migrations, shared infrastructure, refactors, or unavoidable technical sequencing; use hybrid slicing when both are required.
5. **Validate the plan** — merge tasks that cannot be independently executed or verified; split tasks that are too broad to have a coherent responsibility or acceptance boundary. Never split mechanically by files, layers, or classes.
6. **Preserve uncertainty** — do not convert missing information into invented requirements. Record unresolved decisions and blockers; stop only when they prevent a safe decomposition.
7. **Review / HITL** — present the complete task plan, slicing rationale, dependencies, parallelizable work, risks, and unresolved decisions. Wait for explicit approval before creating remote backlog items.
8. **Create backlog through AFK** — after approval, invoke the repository's AFK CLI backlog command to create the approved items and supported relationships automatically.
9. **Verify** — confirm that every planned item was created, relationships were established, and each item is traceable to the source PRD.

## Task Decomposition

A task should normally satisfy all three conditions:

- **Coherent responsibility** — one clear outcome or implementation boundary.
- **Independent execution** — it can be worked on independently except for declared dependencies.
- **Independent verification** — completion can be demonstrated with concrete evidence.

### Vertical slicing — preferred

Use a vertical slice when the work represents a coherent business capability or user-visible outcome. A slice may span domain, application, API, UI, persistence, and tests when those changes are required for the same outcome.

```text
Document permission inheritance
├── permission rules
├── API behavior
├── persistence changes
├── UI behavior
└── tests
```

Do not turn each layer into a separate issue merely because the code is organized into layers.

### Horizontal slicing — purposeful

Use a horizontal slice when the work is foundational or inherently technical, such as database/schema migration, shared infrastructure, framework/SDK changes, reusable platform components, large refactors, or work with unavoidable technical sequencing.

Horizontal work must still have a concrete responsibility and verification boundary. Do not use horizontal slicing merely because the repository has layered architecture.

### Hybrid slicing

Use hybrid decomposition when a shared foundation enables several independently deliverable capabilities.

```text
Foundation
├── permission model
└── permission engine

Capabilities
├── permission API
├── permission UI
└── inheritance behavior

Integration
└── end-to-end verification
```

### Choosing the strategy

Select the slicing strategy from evidence, not a fixed quota:

| Signal | Preferred strategy |
|---|---|
| Independent business capability / user outcome | Vertical |
| User story with end-to-end acceptance | Vertical |
| Database, infrastructure, migration, shared platform | Horizontal |
| Large refactor with strict technical sequencing | Horizontal |
| Shared foundation followed by independent capabilities | Hybrid |
| Unclear boundary | Inspect further; ask only if the ambiguity blocks safe decomposition |

Explain the selected strategy and why it fits the repository and PRD.

## Dependencies and Parallelism

Build a dependency DAG rather than a flat task list. Identify:

- prerequisites
- blocked-by / blocking relationships
- parallelizable tasks
- integration points
- verification tasks

Do not introduce dependencies merely because two tasks touch the same module. Reject dependency cycles. Identify the earliest executable tasks and groups that can safely run in parallel.

## Evidence and Traceability

For every task, inspect the codebase to determine:

1. What existing components can be reused or extended.
2. What files/modules/tests are actually affected.
3. What proves the acceptance criteria.
4. What command or other evidence can verify completion without mutating state.

Do not invent APIs, architecture, limits, product behavior, or implementation details without evidence. Existing backlog items must be checked to avoid duplicate work.

Every backlog item must reference the source PRD and preserve its relevant acceptance criteria. Technical verification may be added only when it is directly necessary to prove an approved requirement.

## Backlog Item Contract

Each item should contain:

```yaml
- title: <short imperative title>
  description: <context and intended outcome>
  parent: <planned parent reference or root backlog; organizational only>
  base_backlog: <optional planned backlog whose unmerged branch is the explicit git base>
  depends_on: [<planned task references>]
  execution_mode: afk | hitl
  tags: [<business tags>]
  acceptance_criteria:
    - text: <observable condition>
      evidence_type: test | curl | log | manual | none
      check_command: <non-mutating command that exits 0 on pass>
  out_of_scope: [<explicit non-goals>]
  source: <PRD reference>
```

Use stable temporary task references while planning. After approval, resolve
each reference to the canonical ID and URL returned by `afk backlog create`.
The approved PRD root is the parent of every created child. `parent` is
organizational only: it MUST NOT select a git branch or worktree base.
Dependencies control execution order. Use `base_backlog` only for intentional
stacked work that must start from another backlog's unmerged branch; otherwise
children start from the configured target branch. Keep the graph acyclic.

## Verification Inference

For each acceptance criterion, inspect the repository and infer the strongest available evidence:

- `test` — automated test proves the behavior.
- `curl` — HTTP/API behavior can be verified directly.
- `log` — an authoritative runtime signal proves the result.
- `manual` — a human check is required.
- `none` — no reliable signal exists yet.

Provide a concrete `check_command` only when it is repository-supported, non-mutating, and exits 0 on success. Never fabricate commands or evidence types.

## Self-Quality Gate

Before HITL approval:

- verify every task has a coherent scope;
- verify acceptance criteria are observable;
- verify evidence and check commands are real and non-mutating;
- verify dependencies are acyclic;
- verify duplicate work has been ruled out;
- verify slicing choices are justified;
- verify parallelization opportunities;
- verify unresolved decisions are explicit.

Run safe check commands where practical. Fix failures or revise the plan before requesting approval.

## AFK CLI Backlog Creation

The agent owns reasoning and planning; the AFK CLI owns deterministic backlog operations.

After explicit approval, automatically invoke the repository's AFK CLI backlog creation capability. Do not ask the user to manually create backlog items. Do not directly use `gh issue create` or provider APIs when an AFK CLI capability exists.

Require the approved root reference before creating any child:

```text
rootBacklogId: <returned by /afk-to-prd>
rootBacklogUrl: <returned by /afk-to-prd>
```

Create approved items one at a time in topological dependency order. Write
each body to a temporary Markdown file and include this traceability section:

```markdown
## PRD

[PRD root backlog](<rootBacklogUrl>)
```

Invoke AFK with canonical IDs only:

```bash
# Omit --base-backlog unless stacking from an unmerged predecessor branch.
afk backlog create "<title>" \
  --description-file /tmp/backlog-<temporary-ref>.md \
  --parent <rootBacklogId> \
  --base-backlog <canonical-unmerged-base-id> \
  --depends-on <canonical-dependency-id> \
  --mode <afk|hitl> \
  --tag <business-tag>
```

Repeat `--depends-on` and `--tag` for every declared value. Use
`--base-backlog` only when the implementation plan explicitly requires an
unmerged predecessor branch; a completed dependency is already available from
the target branch. Record the returned `Created backlog <id>` and `url:` for every temporary reference. AFK
writes `## Backlog Links` with the concrete self, parent, and dependency URLs.
Use returned IDs and URLs for subsequent items; never construct them.

If a command fails, stop and report every already-created temporary reference,
canonical ID, and URL. Do not bypass AFK with a provider API.

If the AFK CLI lacks a required operation, report the capability gap instead of silently bypassing the CLI.

## Completion

The skill is complete only when:

- the decomposition was reviewed and approved;
- every created backlog item maps to an approved task;
- dependencies and supported relationships are established;
- acceptance criteria and verification evidence are preserved;
- created backlog identifiers are recorded; and
- created backlog URLs are recorded; and
- the resulting backlog is traceable to the published PRD.

Do not begin implementation, modify the PRD, or create ADRs. Those responsibilities belong to other workflows.

## References

Read `references/ddd-slicing.md` for slicing guidance and
`references/issue-template.md` for acceptance-criteria and PRD-link
conventions. These references support planning; repository evidence and the
published PRD remain authoritative.
