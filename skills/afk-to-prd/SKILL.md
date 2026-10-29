---
name: afk-to-prd
disable-model-invocation: true
description: >-
  Clarify and confirm product requirements, then publish a concise,
  standards-based PRD for AI task decomposition and coding.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# PRD

**Goal:** Produce a concise, confirmed product requirements document that
humans can review and AI can decompose, implement, and verify.

**Mode:** Clarification and approval are mandatory. Never publish a PRD that
contains unresolved product decisions or unconfirmed assumptions.

**Boundary:** This skill defines product context and observable product
behavior. It does not prescribe code, internal architecture, implementation
tasks, test commands, or backlog-provider records. After PRD approval, stop;
`afk-to-issues` owns repository analysis and task decomposition.

## Workflow

### 1. Understand and inspect

Read the user's request and any provided alignment record, existing PRD, and
relevant product documentation. Reuse confirmed information; do not ask again
for answers already available. Distinguish missing information from technical
choices that implementation can decide later.

### 2. Clarify before drafting

Identify ambiguities that could change the product's goals, user experience,
business rules, scope, permissions, data handling, failure behavior, or
acceptance criteria. Ask focused questions and explain options when useful.
Batch related questions to reduce round trips.

- Treat only explicit user confirmation or an authoritative, applicable source
  as confirmation. Silence, lack of objection, and model inference are not
  approval.
- Do not invent business policies, user commitments, metrics, constraints, or
  observable behavior.
- If a material product decision remains unresolved, stay in clarification;
  do not generate or publish the formal PRD.
- Do not ask users to decide internal code structure, class/function names,
  database schema, framework, or other implementation details unless the
  choice is an explicit product or organizational constraint.

### 3. Draft the PRD

Only start drafting after all material product decisions needed for the current
scope are confirmed. Always read `references/prd-template.md`.

The PRD must cover:
- Background and problem statement: why this matters and who is affected.
- Goals and success measures, where a measure has been confirmed.
- Target users and user stories that state capability and user value.
- In-scope and out-of-scope behavior.
- Functional requirements and observable acceptance criteria.
- Confirmed business rules and material product constraints.

Use tables for requirements, rules, acceptance criteria, decisions, and other
naturally tabular information. Use concise prose for context and user stories.
Add NFRs, state models, flows, or diagrams only when confirmed and useful to
understanding the product behavior.

### 4. Enforce the product/implementation boundary

Describe what users or external consumers can do, what the product guarantees,
and what observable outcome occurs. Do not put code snippets, function or class
names, source file paths, internal module structure, database schemas, ORM
details, framework choices, internal algorithms, deployment topology, or
implementation task breakdowns in the PRD.

Public integration contracts may specify externally observable inputs, outputs,
errors, compatibility, and guarantees when these are part of the product
promise. Put implementation decisions in a separate technical design or ADR.

### 5. Review and validate

Run the PRD validator when a file path is available:

```bash
python3 skills/afk-ai-prd/scripts/validate_prd.py /path/to/PRD.md
```

Then review the content semantically. Confirm that background, problem, goals,
users, stories, scope, requirements, rules, and acceptance criteria agree.
Ensure every material requirement is based on confirmed information and that
the document contains no unresolved product questions, placeholder values, or
unapproved assumptions.

The validator can check document structure and common defects; it cannot prove
that a user actually confirmed a business decision. The workflow must preserve
that confirmation discipline.

### 6. Approval and publication

Present the completed PRD and validation result. Ask for an explicit outcome:
- **Approve** — write/publish the approved PRD and stop.
- **Revise** — incorporate feedback, re-check confirmation status, and validate.
- **Clarify** — return to the clarification step; do not publish.

Do not write an approved artifact or hand it downstream before explicit
approval. After approval, end the skill. Do not create tasks, issues, branches,
or implementation plans.

## Completion criteria

A PRD is ready only when:
- all material product decisions in scope are confirmed;
- standard PRD context and user stories explain why and for whom the product is
  being built;
- requirements and acceptance criteria describe observable behavior;
- no unresolved questions, assumptions, or placeholders remain in the PRD;
- content is concise, table-first where appropriate, and free of code-level
  implementation detail;
- the user explicitly approves publication.

## References

| File | Read when |
|---|---|
| `references/prd-template.md` | Always, before drafting |
| `references/adr-process.md` | Only when a technical decision must be handled separately; do not put implementation detail in the PRD |
