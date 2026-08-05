---
name: software-complexity-governance
description: Detect software complexity and map hotspots to code smells and refactorings. Use when measuring cyclomatic or cognitive complexity, maintainability, coupling, LOC, or when asked for complexity analysis, code smells, 圈复杂度, 认知复杂度, 代码异味, or technical-debt prioritization from complexity metrics.
---

# Software Complexity Governance

**Goal:** measure complexity at project / module / file / method scope, report hotspots, map them to code smells, and recommend refactorings and quality gates.

**Contract:** scope (path or method) yields structured metrics report, smell mapping, and governance actions.

## Steps

### 1 - Clarify scope

If ambiguous, ask: whole project, one module/directory, one file, or one method?
Detect language(s) from extensions or user input.

### 2 - Load metrics and tool guidance

Read `references/metrics-detail.md` for definitions, formulas, and thresholds.
Read `references/tools-cheatsheet.md` for which analyzer to use per language.
Prefer multi-language lizard for mixed trees; radon / complexipy for Python;
language linters where they already own complexity rules.

### 3 - Measure

Run the chosen analyzer on the scoped path (or isolate a single method).
Collect at least: cyclomatic, cognitive (when available), size (NLOC/LOC),
parameter count, and any coupling signals the tool provides.
Aggregate for project/module: averages, maxima, distribution, top offenders.

### 4 - Map smells and recommend actions

Read `references/smells-refactorings.md`.
Map high-complexity items to smells (Long Method, Large Class, Conditional
Complexity, Feature Envy, and related) and list priority refactorings.
Read `references/governance-playbook.md` for gate thresholds and process advice.

### 5 - Report

Present:

- Summary (scope, languages, key aggregates)
- Top offenders with location and metric values
- Threshold violations
- Smell to refactoring recommendations
- Suggested quality gates / CI checks for new code

Prefer actionable output over theory. Re-measure after refactoring when asked.

## Caveats

- Metrics are proxies; context (domain, generated code, performance paths) matters.
- Do not fail closed on a single metric - pair structural (CC) with cognitive and size.
- Exclude or loosen thresholds for generated, third-party, and pure test fixtures unless asked otherwise.
- MUST NOT invent tool output; if tools are unavailable, state that and fall back to formula-based review of provided source only.
- MUST NOT treat lowering one number as success if design worsens (for example excessive extraction).
