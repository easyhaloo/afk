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

Project:
- Prefer Clean-as-You-Code gates on new/changed code
- Track trends of averages, maxima, and debt ratio
- Review hotspots (high complexity × high change frequency) on a fixed cadence

## Refactoring direction (detail in smells-refactorings.md)

Extract method/class; flatten nesting (guards, early return); replace conditionals
with polymorphism or strategy; introduce parameter objects; split high-CBO modules;
hide incidental complexity behind clear abstractions; remove dead complexity.

## Process

- CI: warn or fail on threshold breaches for changed files.
- PR: justify or refactor any new function above threshold.
- Debt backlog: estimate remediation cost; prioritize by business impact and churn.
- Document exceptions; do not chase a single metric into worse design.

## Caveats

Generated, vendored, and pure fixture code usually need looser or excluded gates.
Combine static metrics with coverage, runtime evidence, and human review.
