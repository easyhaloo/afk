---
name: software-complexity-governance
description: >-
  Assess and govern software complexity from method to repository scope. Use when
  measuring cyclomatic or cognitive complexity, code smells, coupling, module or
  service boundaries, duplication, change hotspots, or technical-debt priority.
---

# Software Complexity Governance

**Goal:** turn repository evidence into prioritized complexity findings and
verifiable governance actions. Analyze the requested scope at four levels:
code, module/service, and change complexity. Measure first, diagnose causes,
prioritize hotspots, recommend proportionate action, and re-measure when changes
are made.

**Core rule:** a high metric is evidence, not an automatic refactoring mandate.
Judge complexity with baseline, trend, change frequency, change spread,
dependency impact, business criticality, and available verification evidence.

## Workflow

### 1 - Establish scope

Determine the requested target: repository, module/directory, file, class, or
method. Detect languages and relevant build/test tooling from the repository.
If scope or the desired dimension is genuinely ambiguous, ask before measuring.

### 2 - Gather evidence

Inspect the target code and relevant repository guidance before interpreting
metrics. Load only the references needed for the scope:

| Need | Read |
|------|------|
| Metric definitions and thresholds | `references/metrics-detail.md` |
| Analyzer selection and commands | `references/tools-cheatsheet.md` |
| Module/service boundaries and change coupling | `references/module-service-boundaries.md` |
| Duplication and reuse decisions | `references/duplication-reuse.md` |
| Smell → refactoring mapping | `references/smells-refactorings.md` |
| Governance gates and prioritization | `references/governance-playbook.md` |

Use repository evidence over generic assumptions. Never invent analyzer output,
git history, or unavailable measurements.

### 3 - Measure the applicable complexity layers

Measure only dimensions supported by the language and tooling:

- **Code:** cyclomatic, cognitive complexity, size, parameters, nesting,
coupling and related signals.
- **Module/service:** dependency direction, cycles, fan-in/fan-out, ownership,
shared data, boundary crossings.
- **Change:** churn, co-change, files/modules per change, cross-boundary change,
when history is available.
- **Duplication:** textual, structural, behavioral, and semantic duplication;
prioritize duplicated business rules over incidental similarity.

For collections, report distribution and top offenders rather than averages alone.

### 4 - Diagnose hotspots

Do not equate one bad metric with a defect. Correlate evidence and identify the
likely cause:

```text
Metric anomaly
  + change frequency / spread
  + dependency or boundary impact
  + business / operational criticality
  + verification evidence
  → hotspot and root cause
```

Classify the cause where possible as local code complexity, boundary complexity,
duplication/reuse debt, change coupling, or a combination.

### 5 - Prioritize intervention

Prioritize places where complexity creates meaningful change cost or risk. A
stable, rarely changed algorithm with high CC may be lower priority than a
moderately complex hotspot changed across many modules every week.

Use the governance references to derive a qualitative or quantitative hotspot
score when enough evidence exists. Always show the evidence behind the ranking.

### 6 - Recommend proportionate actions

Choose the smallest intervention that addresses the diagnosed cause:

- local complexity → simplify, guard clauses, Extract Method/Class, reduce nesting
- boundary problem → merge, split, or realign ownership
- repeated business semantics → consolidate into an owned shared capability
- change coupling → reduce dependency or clarify ownership
- unstable architecture → address the boundary before polishing local methods

Do not refactor solely to satisfy a threshold. Do not introduce a generic
`common` layer without clear ownership, contract, and stable shared semantics.

### 7 - Define governance and verify

For findings that warrant action, provide a measurable gate and the evidence
needed to verify it. Prefer trend and regression controls over one-time limits.
When changes are actually made, re-run the relevant measurements and compare
against the baseline.

### 8 - Report

Return a concise, evidence-backed assessment containing:

1. **Scope & evidence** — what was inspected and what was measurable.
2. **Health summary** — major risks and complexity dimensions.
3. **Hotspots** — ranked locations, evidence, likely root cause, and impact.
4. **Actions** — priority, recommended intervention, and expected outcome.
5. **Governance gates** — thresholds, trends, or structural rules justified by
repository context.
6. **Verification** — commands or measurements that can prove improvement.

For method/file requests, stay focused on the requested scope while noting a
higher-level boundary issue only when evidence shows it materially affects the
finding.

## Decision Principles

- **Threshold ≠ verdict.** Combine metric, baseline, trend, and change behavior.
- **Hotspot > raw score.** Prioritize complexity that repeatedly costs the team.
- **Cause before refactor.** Diagnose why complexity exists before choosing a fix.
- **Boundary before polish.** Do not optimize methods inside a broken boundary.
- **Semantic reuse > textual reuse.** Similar code is not automatically shared code.
- **Evidence before confidence.** State unavailable measurements explicitly.
- **Re-measure after change.** Governance is continuous, not a one-time scan.

## Caveats

- Metrics are proxies; domain complexity and generated code can distort results.
- Pair CC with cognitive complexity, size, coupling, and change evidence when
available instead of relying on a single metric.
- Exclude or loosen thresholds for generated, third-party, and fixture code unless
explicitly requested.
- Never fabricate tool output, git statistics, thresholds, or repository facts.