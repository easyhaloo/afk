---
name: afk-to-prd
disable-model-invocation: true
description: >-
  Clarify and confirm product requirements, then create, review, revise, validate,
  and publish a concise AI-ready PRD containing confirmed product decisions only.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# PRD

**Goal:** Produce one concise, confirmed product requirements document that humans can review and AI can decompose, implement, and verify.

**Modes:**

| Mode | Input | End state |
|---|---|---|
| Create | User request, confirmed requirements, or alignment record | Approved, validated PRD |
| Review | Existing PRD | Findings and pass/fail review; do not silently edit |
| Revise | Existing PRD and explicit feedback | Updated, re-confirmed, validated PRD |

**Boundary:** This skill owns product clarification and the PRD artifact only. It does not prescribe code or internal architecture, split implementation tasks, create issues/backlog records, select branches, start implementation, or run QA workflows. After approval, stop; `afk-to-issues` owns repository analysis, task decomposition, dependency planning, and backlog creation.

## Workflow

### 1. Inspect context

Read the user's request, existing PRD, alignment notes, and relevant product documentation. Always read `references/prd-template.md` before creating or revising. Reuse confirmed information and do not ask again for questions already answered by an authoritative applicable source.

### 2. Clarify before drafting

Identify missing or conflicting decisions that could change product goals, user value, behavior, scope, business rules, permissions, data handling, failure behavior, quality expectations, or acceptance criteria. Ask focused questions, group related questions, and offer alternatives when useful.

- A decision is confirmed only when the user explicitly confirms it or an authoritative applicable source establishes it. Silence and model inference are not confirmation.
- Do not invent business policies, metrics, commitments, constraints, or observable behavior.
- If a material product decision remains unresolved, continue clarification. Do not draft or publish a formal PRD containing unresolved decisions.
- Do not ask users to choose internal code structure, class/function names, database schemas, frameworks, or other implementation details unless they are explicit organizational constraints or affect the product contract.

### 3. Write the standard PRD

Keep the document concise. Use tables where they improve scanability; use short prose for context and user stories. Retain the standard product context:

- Background and problem: why the work matters and who is affected.
- Goals and success measures, using only confirmed targets.
- Target users and user stories expressing capability and value.
- In-scope and out-of-scope behavior.
- Functional requirements with observable acceptance criteria.
- Confirmed business rules and material product/quality constraints.

Use stable IDs: `GOAL-###`, `USER-###`, `FR-###`, `AC-###`, `BR-###`, and `NFR-###`. Keep IDs stable when revising the same concepts and never reuse retired IDs. Every functional requirement must have at least one testable acceptance criterion. Ensure references resolve and include traceability where useful.

### 4. Keep product requirements implementation-neutral

Describe what users or external consumers can do, what the product guarantees, and what observable outcomes occur. Do not include code snippets, function/class names, source file paths, internal module structure, database schemas, ORM details, framework choices, internal algorithms, deployment topology, test commands, issue IDs, or implementation task breakdowns.

Public integration contracts may describe confirmed external inputs, outputs, observable errors, compatibility, and guarantees when they are part of the product promise. Put implementation decisions in a separate technical design or ADR.

### 5. Validate and review

When a PRD file is available, run:

```bash
python3 skills/afk-to-prd/scripts/validate_prd.py /path/to/PRD.md
```

Then review the content semantically. Confirm that background, problem, goals, users, stories, scope, requirements, rules, and acceptance criteria agree. Confirm every material product decision is grounded in explicit confirmation and that the formal PRD contains no unresolved questions, assumptions, proposals, or placeholders.

The validator checks structure and common textual defects; it cannot prove that a user confirmed a decision. The workflow must preserve that confirmation discipline. Read `references/diagram-guidelines.md` when a diagram materially clarifies a confirmed product flow or lifecycle.

### 6. Approval and publication

Present the PRD and validation findings, then request an explicit outcome:

- **Approve** — write/publish the approved artifact and stop.
- **Revise** — incorporate feedback, re-check confirmation, and validate again.
- **Clarify** — return to clarification; do not publish.

Do not publish or hand off an unapproved draft. An approved PRD contains confirmed product facts and decisions only; never leave `TBD`, `TODO`, `Unknown`, `Proposed`, open questions, or unapproved assumptions in it.

## Completion criteria

A PRD is ready only when:

1. Background and problem explain the context and affected users without prescribing a solution.
2. Goals and success measures are grounded in confirmed information.
3. Target users and user stories express user needs and value.
4. Scope states included behavior and meaningful exclusions.
5. Each FR describes one coherent, observable product behavior and has at least one testable AC.
6. Relevant business rules, permission boundaries, failure behavior, and quality constraints are explicit.
7. IDs are unique, stable, and internally consistent; references resolve.
8. No unresolved product decision, assumption, proposal, placeholder, or contradictory requirement remains.
9. No code-level implementation detail or unnecessary technical design is included.
10. Tables and optional diagrams improve clarity without making the document verbose.
11. The user explicitly approves publication.

## References

| File | Read when |
|---|---|
| `references/prd-template.md` | Always, before creating or revising a PRD |
| `references/diagram-guidelines.md` | When a diagram would materially clarify a confirmed product flow or lifecycle |
| `references/adr-process.md` | Only when a technical decision must be handled separately |
| `scripts/validate_prd.py` | When a PRD file is available for automated validation |
