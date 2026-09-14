---
name: afk-ai-prd
description: >-
  Create, review, or revise an AI-Friendly Product Requirements Document in
  Markdown. Use when a user wants a PRD that an AI can parse, question,
  decompose, implement, and verify. The skill defines fixed Markdown sections,
  atomic requirements, Mermaid diagrams, stable IDs, traceability, and a
  self-check gate. Do not use it to create provider records or execute backlog
  items.
---

# AI-Friendly PRD

**Goal:** Produce a human-reviewable Markdown PRD that functions as an
execution contract for AI and downstream backlog or QA workflows.

**Output:** An approved `PRD.md` written in Markdown. Use Mermaid source for
diagrams. Do not use JSON or YAML to express PRD content.

**Boundary:** This skill writes and audits the PRD only. It does not create
backlog records, select branches, start implementation, run QA workflows, or
publish provider metadata. If the input is only an unaligned idea, clarify it
before drafting rather than inventing requirements.

**Language standard:** Use semantically dense, domain-standard product and
engineering vocabulary. Prefer precise terms such as actor, trigger,
precondition, postcondition, invariant, state transition, idempotency,
authorization, compatibility, auditability, observability, and failure mode
over generic prose. Use the model's prior knowledge to improve terminology,
surface common edge cases, and propose established patterns, but never present
a model-derived assumption as a confirmed product fact.

## When to Use

Use this skill when the user asks to:

- create an AI-friendly, machine-readable, or execution-ready PRD;
- standardize a PRD for AI implementation or task decomposition;
- review whether a Markdown PRD is complete, unambiguous, and verifiable;
- add flowcharts, sequence diagrams, or state diagrams to a PRD.

Do not use it for a generic product brief, marketing copy, technical design
document, or backlog-provider import. Route an unstructured idea through a
requirements-alignment workflow first when the problem, users, or scope are
unknown.

## Operating Modes

| Mode | Input | End state |
|---|---|---|
| **Create** | Alignment record or sufficiently detailed requirements | Drafted, self-checked, human-approved `PRD.md` |
| **Review** | Existing Markdown PRD | Findings and a pass/fail self-check; do not silently edit |
| **Revise** | Existing PRD plus explicit feedback | Updated, self-checked PRD with change impact noted |

## Writing Workflow

### 1. Establish the source of truth

Classify input statements as facts, decisions, assumptions, open questions, or
conflicts. Do not turn an assumption or open question into a requirement.
Preserve unresolved items in `Open Risks`. If the input is insufficient for a
safe requirement, use prior knowledge to propose the smallest set of likely
interpretations or industry-standard options, label them as proposals, and
ask for the missing decision. Do not silently choose one.

Use prior knowledge in four controlled ways:

- **Terminology** — normalize informal language to precise domain terms;
- **Coverage** — surface likely permission, failure, retry, timeout, recovery,
  concurrency, compatibility, audit, and accessibility concerns when relevant;
- **Alternatives** — propose established product patterns with concise tradeoffs;
- **Validation** — challenge vague, contradictory, or non-falsifiable claims.

Do not use prior knowledge to invent business policies, user commitments,
numeric targets, legal requirements, existing APIs, system capabilities, or
architecture decisions. Record those as `Assumptions` or `Open Risks` until
confirmed.

### 2. Draft the fixed Markdown structure

Read `references/ai-prd-template.md` before creating or revising a PRD. Keep
the section names and item ID prefixes defined by that template. A PRD may
omit a conditional diagram section only when the section explicitly states
why it is not applicable.

### 3. Write atomic requirements

The PRD describes **product behavior at the product boundary**, not every
implementation detail. First state what a user, API consumer, event consumer,
or operator can rely on. Then include UI or API details only when that surface
is itself part of the product promise.

Use this boundary:

| Surface | Include in the PRD | Leave to a downstream design document |
|---|---|---|
| User interface | User action, visible result, permission, error, and state | Pixel layout, component hierarchy, CSS, framework choices |
| Public API | Consumer intent, input rules, response meaning, errors, idempotency, and compatibility | Route naming, controller structure, ORM, database tables |
| Event or webhook | Trigger, payload meaning, delivery guarantees, ordering, and retry semantics | Broker topology and internal handler structure |
| CLI or batch | Command intent, accepted inputs, observable output, and exit behavior | Shell internals and process orchestration |

Add a `Surface` field to every requirement using one of `User`, `Public API`,
`Event`, `CLI/Batch`, or `Policy`. If a single product behavior has both a UI
and an API surface, keep one product requirement and describe the two views as
related observations rather than creating contradictory duplicate requirements.

Each functional requirement must:

- have a unique `FR-###` ID and one imperative title;
- identify the actor, bounded context, trigger, and preconditions;
- describe the main flow, abnormal flows, postconditions, and invariants;
- contain at least one `AC-###` acceptance criterion;
- use observable outcomes rather than implementation guesses;
- avoid combining independent behaviors under one ID.

Do not make an endpoint, React component, database table, or internal service
the requirement itself. Those may appear as a confirmed constraint or a
downstream technical design, but the requirement must still state the product
promise they serve.

Use `MUST`, `SHOULD`, and `MAY` when priority or obligation could otherwise be
ambiguous. Quantify limits for time, count, size, permissions, retries, and
retention whenever they affect behavior.

Write with high information density:

- lead with the actor, trigger, and outcome;
- use one canonical term for each concept;
- prefer explicit constraints over adjectives;
- state the invariant or failure consequence when it changes implementation;
- remove background explanation that does not affect a decision or behavior.

When the input is underspecified, distinguish the following labels in prose:

- **Confirmed** — directly stated or explicitly approved;
- **Inferred** — derived from context or domain convention;
- **Proposed** — a candidate supplied by the model for review;
- **Unknown** — not safely inferable and requiring a decision.

Only `Confirmed` content may define an approved requirement. `Inferred` and
`Proposed` content must be traceable to an assumption or open risk before
approval.

### 4. Add the right diagrams

Read `references/diagram-guidelines.md` when the PRD contains a non-trivial
flow, cross-boundary interaction, lifecycle, or rule tree. Use Mermaid as the
canonical source:

- flowcharts for user and business flows;
- sequence diagrams for cross-boundary interactions;
- state diagrams for lifecycle transitions;
- decision trees for branching business rules when a flowchart would be less
  clear.

Every diagram gets a stable `FLOW-###`, `SEQ-###`, `STATE-###`, or `RULE-###`
ID, a purpose, and links to related requirement and acceptance-criteria IDs.
Diagrams supplement prose; they do not replace requirements. Report conflicts
between prose and diagrams as an `Open Risk` instead of choosing silently.

### 5. Model uncertainty and scope

Keep these sections separate:

- `Key Decisions`: confirmed choices and their rationale;
- `Assumptions`: unverified beliefs that the design currently depends on;
- `Open Risks`: unresolved questions, contradictions, or material unknowns;
- `Non-Goals`: explicitly excluded work.

Every risk that can change implementation scope must identify its affected
requirement IDs and the point before which it must be resolved.

### 6. Capture technical boundaries without writing the design

Use the optional `Technical Constraints & Decisions` section when a technical
fact changes product behavior, quality targets, compatibility, security,
compliance, scope, or material delivery risk. Describe what the product must
guarantee and why. Leave the concrete implementation to a separate Technical
Design document.

Include examples such as:

- an idempotency guarantee for repeated requests;
- a response-time or availability target;
- an audit or data-retention obligation;
- a compatibility requirement for an external consumer;
- a confirmed system boundary that affects the user-visible flow.

Do not put endpoint names, database schemas, class/module structure, framework
choices, deployment topology, or internal algorithms in the PRD unless they are
an explicit organizational constraint. If such a detail is needed, record the
constraint and link to Technical Design rather than prescribing the solution.

### 7. Build traceability

Link each goal to one or more requirements, each requirement to one or more
acceptance criteria, and each diagram to the requirements it explains. Use the
`Traceability` table in the template. Do not add issue IDs, provider labels,
branch names, or execution states to the PRD.

### 8. Run the self-check before approval

Run the bundled validator when a file path is available:

```bash
python3 skills/afk-ai-prd/scripts/validate_prd.py /path/to/PRD.md
```

Then perform the semantic review below. Fix all errors before requesting
approval. Warnings require an explicit product decision or a documented risk.

## Self-Check Contract

The PRD passes only when all of these are true:

1. Required sections exist and remain in the prescribed order.
2. All item IDs are unique and use the approved prefixes.
3. Every `FR-###` has actor, trigger, preconditions, main flow, abnormal flow,
   completion conditions, invariants, and at least one acceptance criterion.
4. Every acceptance criterion has a `Given`, `When`, and `Then` statement.
5. Every goal maps to at least one functional requirement.
6. Every functional requirement maps to at least one acceptance criterion.
7. State transitions do not contradict the prose or include unexplained
   terminal-state changes.
8. Every Mermaid diagram has a diagram ID, purpose, and requirement links.
9. No material requirement is hidden in a diagram without corresponding prose.
10. No unresolved question is presented as a confirmed decision.
11. No non-goal is required by an in-scope requirement.
12. No vague or non-falsifiable wording remains without a measurable definition.
13. No requirement silently invents an API, database, component, or behavior
    unless it is explicitly recorded as a constraint or decision.
14. Technical constraints describe product guarantees, not an unapproved
    implementation design.
15. Model-derived proposals and inferred edge cases are labeled and do not
    become confirmed requirements without approval.
16. The change log and downstream impact are updated when revising an approved
    PRD.

## Approval Gate

Present the self-check result and ask for one explicit outcome:

- **Approve** — write the approved artifact and stop;
- **Revise** — incorporate the specified changes and run the self-check again;
- **Clarify** — preserve the gap as an open risk and ask one focused question;
- **Reject** — discard the draft or return it to requirements alignment.

Do not hand off or mutate external systems before approval.

## Caveats

- Markdown is the only PRD representation; do not replace it with JSON or YAML.
- Mermaid source, not a screenshot, is the diagram source of truth.
- The primary concern is product behavior. UI behavior is included for a UI
  product surface; API behavior is included for a public or integration API
  surface. Neither should silently become an implementation specification.
- Technical constraints may be included when they affect the product contract;
  detailed Technical Design belongs in a separate document.
- Use model prior knowledge to improve coverage and vocabulary, not to invent
  product facts or silently resolve business decisions.
- Do not invent missing user stories, metrics, policies, or error behavior.
- Do not put test commands or provider-specific evidence fields in the PRD;
  downstream decomposition may add those separately.
- Do not modify the existing `afk-to-prd` skill as part of this workflow.

## References

| File | Read when |
|---|---|
| `references/ai-prd-template.md` | Always, before creating or revising a PRD |
| `references/diagram-guidelines.md` | When adding or reviewing diagrams |
| `scripts/validate_prd.py` | When a PRD file is available for automated self-check |
