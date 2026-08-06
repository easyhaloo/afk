---
name: software-complexity-governance
description: >-
  Detect code and organization complexity; map hotspots to smells and refactorings;
  assess module/service boundaries and feature duplication. Use when measuring
  cyclomatic or cognitive complexity, coupling, maintainability, 圈复杂度, 认知复杂度,
  代码异味, 功能组织复杂度, 模块边界, 服务边界, 重复功能, or technical-debt prioritization.
---

# Software Complexity Governance

**Goal:** measure complexity at project / module / service / file / method scope;
report hotspots; map to smells and refactorings; assess organization complexity
at module and service boundaries; flag copy-paste duplication for shared capability extraction.

**Contract:** scope yields metrics report, boundary/organization findings,
smell mapping, reuse (anti-CP) actions, and governance gates.

## Steps

### 1 - Clarify scope and dimension

If ambiguous, ask:

- **Structural:** whole project, module/directory, file, or method?
- **Organization:** module/package graph, service boundaries, or both?

Detect language(s) from extensions or user input.

### 2 - Load guidance

| Need | Read |
|------|------|
| Metric definitions and thresholds | `references/metrics-detail.md` |
| Analyzer choice per language | `references/tools-cheatsheet.md` |
| Module/service boundary and change coupling | `references/module-service-boundaries.md` |
| Duplication vs shared capability (anti-CP) | `references/duplication-reuse.md` |
| Smells to refactorings | `references/smells-refactorings.md` |
| Gates and process | `references/governance-playbook.md` |

### 3 - Measure structural complexity

Run analyzers on the scoped path (or single method).
Collect at least: cyclomatic, cognitive (when available), size (NLOC/LOC),
parameter count, nesting, and coupling signals available from tools.
Aggregate: averages, maxima, distribution, top offenders.

### 4 - Measure organization complexity (module / service)

When scope is project, module, or service (or user asks about boundaries):

- List top-level modules or deployable services.
- Inspect dependency direction, cycles, fan-in/fan-out, shared data ownership.
- Prefer change evidence when available: cross-module PR share, co-change pairs,
  mean modules touched per change.
- Score boundary clarity, change isolation, data ownership per
  `references/module-service-boundaries.md`.

### 5 - Detect duplication and reuse debt

Flag parallel features, near-duplicate modules, or repeated rules implemented
by copy-paste. Prefer extract-to-shared capability over another CP.
Apply `references/duplication-reuse.md` (Rule of Three, correct layer for reuse,
no kitchen-sink common).

### 6 - Map smells and recommend actions

Map high-complexity and high-organization-risk items to smells and refactorings.
Order actions: prune or merge false boundaries → extract shared capability →
then local Extract Method/Class style refactors.

### 7 - Report

Present:

- Summary (scope, languages, dimensions covered)
- Structural top offenders with metric values
- Boundary/organization findings (cycles, hubs, cross-boundary churn, data ownership)
- Duplication / anti-CP recommendations with suggested reuse layer
- Smell → refactoring list
- Suggested quality gates and dependency rules

Prefer actionable output. Re-measure after changes when asked.

## Caveats

- Metrics are proxies; domain and generated code context matter.
- Do not fail closed on one metric; pair CC with cognitive, size, and change coupling.
- Organization complexity is not fixed by lowering method CC alone.
- MUST NOT invent tool or git output; if unavailable, state limits and use
  structure-only or provided evidence.
- MUST NOT treat a fat `common` dump as success; shared layers need owner and contract.
- MUST NOT abstract on first occurrence without confirmed shared semantics.
- Exclude or loosen thresholds for generated, third-party, and pure fixtures unless asked.
