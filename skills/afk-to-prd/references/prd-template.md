# PRD Template

Use this template for every approved product requirements document. Keep the standard sections, but do not add empty or irrelevant sections. Replace all placeholders before approval. A formal PRD contains confirmed product facts and decisions only; unresolved questions stay in the clarification workflow, not in the document.

```markdown
# PRD: <short product or feature name>

| Field | Value |
|---|---|
| Version | <version> |
| Status | Approved |
| Owner | <confirmed owner or owning team> |
| Last updated | <YYYY-MM-DD> |

## 1. Background & Problem

<Briefly describe the business context, why this matters now, who is affected, and the concrete problem or pain point. Avoid describing the solution here.>

## 2. Goals & Success Measures

| Goal | Expected outcome | Success measure |
|---|---|---|
| <confirmed goal> | <observable or business outcome> | <confirmed metric/target, or qualitative outcome if no numeric target was agreed> |

## 3. Users & User Stories

| User | User story | Value |
|---|---|---|
| <target user/role> | As a <role>, I want <capability> | So that <confirmed value> |

## 4. Scope

| In scope | Out of scope |
|---|---|
| <included behavior> | <explicitly excluded behavior> |

## 5. Functional Requirements & Acceptance Criteria

| ID | Requirement | Priority | Acceptance criteria |
|---|---|---|---|
| FR-001 | <one observable product behavior> | Must/Should/May | AC-001: Given <condition>, when <action>, then <observable result> |

## 6. Business Rules

| ID | Rule | Applies when | Observable consequence |
|---|---|---|---|
| BR-001 | <confirmed rule in plain language> | <confirmed condition> | <result when rule applies> |

## 7. Product Constraints & Quality Requirements

| ID | Constraint or quality | Requirement | Rationale |
|---|---|---|---|
| NFR-001 | <confirmed quality attribute or product constraint> | <measurable or observable guarantee> | <confirmed reason> |

## 8. Related Flows / State Model (optional)

<Add a concise table or Mermaid diagram only when it materially clarifies a confirmed flow, lifecycle, or complex rule. Link it to FR/AC IDs.>

## 9. Confirmed Decisions (optional)

| Decision | Confirmed choice | Rationale |
|---|---|---|
| <product decision> | <confirmed answer> | <why, if known> |

## 10. Traceability (optional when needed)

| Goal / User story | Requirement | Acceptance criterion |
|---|---|---|
| <goal or story> | FR-001 | AC-001 |
```

## Authoring Rules

- Keep the required product context: background/problem, goals, users/user stories, scope, functional requirements, and acceptance criteria.
- Include business rules and quality requirements when they affect behavior; omit sections that have no applicable confirmed content rather than filling them with boilerplate.
- A user story expresses user value, not a technical task.
- Each FR describes one coherent, observable product behavior. Each AC states a testable outcome; cover important success, permission, boundary, and failure cases where relevant.
- Use stable IDs: `FR-###`, `AC-###`, `BR-###`, `GOAL-###`, and `NFR-###`. Reuse IDs when revising the same concepts; do not recycle retired IDs.
- Prefer tables for requirements, rules, scope, decisions, and traceability. Use short prose for background and explanations. Do not force every concept into a table when prose is clearer.
- Write only confirmed product facts and decisions. No `TBD`, `TODO`, `Unknown`, `Proposed`, unresolved questions, or unapproved assumptions in an approved PRD.
- Do not include code snippets, function/class names, source paths, database schemas, internal module designs, framework choices, algorithms, deployment details, test commands, issue IDs, or task decomposition.
- Public interfaces may describe externally observable inputs, outputs, errors, and compatibility when they are part of the confirmed product contract.
- State numeric targets only when confirmed. Do not invent metrics or business policies.
- Diagrams are optional and should be included only when they reduce ambiguity.
