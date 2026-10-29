---
name: afk-ai-prd
description: >-
  Create, review, or revise a concise, standards-based PRD for AI task
  decomposition and coding. Clarify unresolved product decisions before
  drafting; approved PRDs contain confirmed product information only.
---

# AI-Ready PRD

**Goal:** Produce a concise product requirements document that explains why a capability is needed, who it serves, what product behavior is required, and how success is verified.

**Output:** An approved Markdown PRD. Use tables where they make requirements, rules, scope, and acceptance criteria easier to scan. Use concise prose for background and user stories. Diagrams are optional and complexity-driven.

**Boundary:** This skill creates, reviews, or revises the PRD only. It does not create backlog items, prescribe code-level implementation, select branches, start implementation, run QA workflows, or publish provider metadata. After approval, `afk-to-issues` analyzes the repository and determines task decomposition.

## Operating Modes

| Mode | Input | End state |
|---|---|---|
| Create | Confirmed requirements or alignment record | Approved, validated PRD |
| Review | Existing PRD | Findings and pass/fail review; do not silently edit |
| Revise | Existing PRD and explicit feedback | Updated PRD after re-confirmation and validation |

## Workflow

### 1. Inspect available context

Read the request, existing PRD, alignment notes, and relevant product documentation. Reuse confirmed information. Do not ask again for a question that already has an authoritative answer.

### 2. Clarify before drafting

Identify missing or conflicting decisions that can change product behavior, user value, scope, business rules, permissions, data handling, quality expectations, or acceptance criteria. Ask focused questions, group related questions, and offer clear alternatives when useful.

- A decision is confirmed only when the user explicitly confirms it or an authoritative applicable source establishes it. Silence and model inference are not confirmation.
- Do not invent business policies, success metrics, user commitments, constraints, or observable behavior.
- If a material product decision remains unresolved, do not draft or publish a formal PRD. Continue clarification instead.
- Do not ask the user to choose internal implementation details unless they are explicit organizational constraints or affect the product contract.
- Technical implementation questions that do not affect product behavior belong to the design/coding phase, not the PRD clarification gate.

### 3. Write the standard PRD

Always read `references/ai-prd-template.md`. The PRD must retain standard product context:

- Background and problem statement: why the work is needed and who is affected.
- Goals and success measures, using only confirmed targets.
- Target users and user stories expressing capability and value.
- Scope and non-goals.
- Functional requirements and observable acceptance criteria.
- Confirmed business rules and relevant product constraints/quality requirements.

Use tables for information that naturally compares or enumerates items. Do not force background, rationale, or user stories into awkward tables. Omit optional sections that add no value rather than filling them with boilerplate.

### 4. Keep product requirements implementation-neutral

Describe observable product behavior and guarantees. Do not include code snippets, function/class names, source file paths, internal module structure, database schemas, ORM details, framework choices, internal algorithms, deployment topology, test commands, or implementation task breakdowns.

For public or external interfaces, describe only the confirmed product contract: consumer intent, input/output meaning, observable errors, compatibility, and guarantees. Detailed technical design belongs in a separate document.

### 5. Validate and review

Run the bundled validator when a local PRD path is available:

```bash
python3 skills/afk-ai-prd/scripts/validate_prd.py /path/to/PRD.md
```

Then manually verify that the background, problem, goals, user stories, scope, requirements, business rules, and acceptance criteria are consistent. Confirm that every material product decision is confirmed and that the formal PRD contains no unresolved questions, assumptions, placeholders, or proposals.

Automated validation can detect structural and textual defects, but cannot prove that the user confirmed a decision. Confirmation must be enforced by the workflow.

### 6. Approval gate

Present the PRD and validation findings and request an explicit outcome:

- **Approve** — publish/write the approved artifact and stop.
- **Revise** — incorporate feedback, re-check confirmation, and validate again.
- **Clarify** — return to clarification; do not publish.

Do not publish or hand off an unapproved draft. After approval, stop. Do not create tasks or backlog records.

## Self-Check Contract

A PRD is ready only when:

1. Background and problem describe the context and affected users without prescribing a solution.
2. Goals and success measures are grounded in confirmed information.
3. Target users and user stories express user needs and value.
4. Scope clearly states inclusion and meaningful exclusions.
5. Each functional requirement describes one coherent, observable product behavior.
6. Each functional requirement has at least one testable acceptance criterion.
7. Relevant business rules, permission boundaries, failure behavior, and quality constraints are explicit.
8. IDs are unique and references resolve.
9. No unresolved product decision, assumption, proposal, placeholder, or contradictory requirement remains.
10. No code-level implementation detail or unnecessary technical design is included.
11. Tables are used where they improve clarity, without making the document verbose or mechanically uniform.
12. Optional diagrams are included only when they reduce ambiguity and agree with the text.
13. The user explicitly approves publication.

## References

| File | Read when |
|---|---|
| `references/ai-prd-template.md` | Always, before creating or revising a PRD |
| `references/diagram-guidelines.md` | When a diagram would materially clarify a confirmed product flow or lifecycle |
| `scripts/validate_prd.py` | When a PRD file is available for automated validation |
