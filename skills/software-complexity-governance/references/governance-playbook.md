# Governance Playbook

## Recommended Quality Gates (starting points)

Method level:
- Cyclomatic ≤ 10 (or 15 for complex domains)
- Cognitive ≤ 15
- NLOC ≤ 40–50
- Parameters ≤ 5–7
- Nesting depth ≤ 3–4

File level:
- Average CC ≤ 5–8
- Max CC ≤ 20
- File NLOC ≤ 300–500
- MI ≥ 65–70

Project:
- No new code violating gates (Clean as You Code)
- Track trend of average / max complexity and debt ratio
- Hotspot list (high complexity × high change frequency) reviewed quarterly

## Refactoring Patterns for High Complexity

1. Extract Method / Function — split long or multi-responsibility blocks.
2. Flatten nesting — early return / guard clauses; replace nested if with strategy or table-driven.
3. Replace conditional with polymorphism or state machine.
4. Introduce parameter object when param count high.
5. Split class / module when CBO or WMC high.
6. Hide incidental complexity behind well-named abstractions (facade, adapter).
7. Delete or move dead / rarely-changed complex code.

See also the full smells ↔ refactorings mapping in smells-refactorings.md.

## Process Integration

- Pre-commit or CI: fail or warn on threshold breach for changed files.
- PR review checklist: any new function > threshold needs justification or refactor.
- Dashboard: SonarQube / CodeScene / custom lizard+radon reports.
- Tech-debt backlog: quantify remediation effort (Sonar SQALE style) and prioritize by business impact + change frequency.
- Education: share “why this metric” and examples of good vs bad complexity in team wiki.

## Caveats

- Metrics are proxies, not absolute truth. Context (domain, performance constraints, generated code) matters.
- Over-focusing on lowering a single number can produce worse designs (excessive extraction, god classes elsewhere).
- Generated / third-party / test code usually excluded or given looser thresholds.
- Combine static metrics with runtime, coverage, and human review.
