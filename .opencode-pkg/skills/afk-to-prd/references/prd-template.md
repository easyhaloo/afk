# AI-Ready PRD Template

This is the canonical template for approved product requirements documents. Keep the required product context, but omit optional sections that do not apply. Replace all placeholders before approval. A published PRD contains confirmed product facts and decisions only; unresolved product questions remain in the clarification workflow and must not appear in the published document.

```markdown
# PRD: <short product or feature name>

| Field | Value |
|---|---|
| Version | <version> |
| Status | Approved |
| Owner | <confirmed owner or owning team> |
| Last updated | <YYYY-MM-DD> |

## 1. Background & Problem

<Briefly describe the business context, why this matters now, who is affected, and the concrete problem or pain point. Do not describe the solution here.>

## 2. Goals & Success Measures

| Goal ID | Expected outcome | Success measure |
|---|---|---|
| GOAL-001 | <confirmed user or business outcome> | <confirmed measure/target, or qualitative outcome if no numeric target was agreed> |

## 3. Users & User Stories

| User ID | User / role | User story | Value |
|---|---|---|---|
| USER-001 | <target user> | As a <role>, I want <capability> | So that <confirmed value> |

## 4. Scope

| In scope | Out of scope |
|---|---|
| <included product behavior> | <explicitly excluded behavior> |

## 5. Functional Requirements & Acceptance Criteria

| Requirement ID | Requirement | Priority | Acceptance criteria |
|---|---|---|---|
| FR-001 | <one coherent, observable product behavior> | Must / Should / May | AC-001: Given <condition>, when <action>, then <observable result> |

## 6. Business Rules

| Rule ID | Rule | Applies when | Observable consequence |
|---|---|---|---|
| BR-001 | <confirmed rule in plain language> | <confirmed condition> | <result when the rule applies> |

## 7. Product Constraints & Quality Requirements

| ID | Constraint / quality | Required outcome | Rationale |
|---|---|---|---|
| NFR-001 | <confirmed quality attribute or product constraint> | <measurable or observable guarantee> | <confirmed reason> |

## 8. Related Flow or State Model

<Add a compact table or Mermaid diagram only when it materially clarifies a confirmed flow, lifecycle, or complex rule. Reference related FR/AC IDs.>

## 9. Confirmed Product Decisions

| Decision | Confirmed choice | Rationale |
|---|---|---|
| <decision> | <confirmed choice> | <reason, if known> |

## 10. Traceability

| Goal / User Story | Requirement | Acceptance Criterion |
|---|---|---|
| GOAL-001 / USER-001 | FR-001 | AC-001 |
```

## Authoring Rules

- Required content: background/problem, goals, target users and user stories, scope, functional requirements, and acceptance criteria.
- Include business rules and quality requirements when they affect product behavior. Omit optional sections with no applicable confirmed content instead of adding boilerplate.
- A user story states a user need and value, not an implementation task.
- Each FR describes one coherent, observable product behavior. Each AC describes a testable outcome. Cover important success, permission, boundary, and failure cases where relevant.
- Use stable IDs: `GOAL-###`, `USER-###`, `FR-###`, `AC-###`, `BR-###`, and `NFR-###`. Keep IDs stable across revisions and never reuse retired IDs.
- Prefer tables for requirements, rules, scope, acceptance criteria, decisions, and traceability. Use concise prose for background and context; do not force every type of content into a table.
- Write only confirmed product facts and decisions. Never leave `TBD`, `TODO`, `Unknown`, `Proposed`, open questions, or unapproved assumptions in an approved PRD.
- Do not include code snippets, function/class names, source paths, database schemas, internal module designs, framework choices, algorithms, deployment details, test commands, issue IDs, or task decomposition.
- Public interfaces may specify confirmed external inputs, outputs, observable errors, compatibility, and guarantees when these are part of the product contract.
- Use numeric targets only when confirmed. Never invent metrics, policies, user commitments, or behavior.
- Use diagrams only when they materially reduce ambiguity. Diagram details must agree with the requirements and link to relevant IDs.
