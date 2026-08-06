# Governance Playbook

## Starting quality gates (calibrate per domain)

Method:

- Cyclomatic ≤ 10 (or ≤ 15 in complex domains)
- Cognitive ≤ 15
- NLOC ≤ 40–50
- Parameters ≤ 5–7
- Nesting depth ≤ 3–4

File:

- Average cyclomatic ≤ 5–8; max ≤ 20
- NLOC ≤ 300–500
- Maintainability index ≥ 65–70

Project / organization:

- Prefer Clean-as-You-Code on new/changed code
- Track averages, maxima, debt ratio trends
- Review hotspots (complexity × change frequency) on a fixed cadence
- Track cross-module/service PR ratio and dependency cycles
- Ban new multi-writer shared databases without explicit exception

## Refactoring direction

Order when both code and organization debt exist:

1. Prune or merge false boundaries; split mixed ownership (see module-service-boundaries).
2. Replace CP clones with one shared capability at the right layer (see duplication-reuse).
3. Local structure: extract method/class; flatten nesting; polymorphism/strategy;
   parameter objects; reduce CBO; remove dead complexity.

Detail mappings: `smells-refactorings.md`.

## Process

- CI: warn or fail on threshold breaches for changed files; optional package dependency rules.
- PR: justify new functions above threshold; justify multi-module touches; reject large CP of existing flows.
- Debt backlog: estimate cost; prioritize by business impact × churn × sharedness.
- Document exceptions; do not chase a single metric into worse design or a kitchen-sink common.

## Caveats

Generated, vendored, and pure fixture code usually need looser or excluded gates.
Combine static metrics with coverage, runtime evidence, change history, and human review.
