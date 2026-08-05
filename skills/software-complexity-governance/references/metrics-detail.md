# Metrics Detail

## Cyclomatic Complexity (McCabe, 1976)

V(G) = E − N + 2P on the control-flow graph.
Practical count: start at 1; +1 per decision (if, else-if, case, loops, catch,
ternary, short-circuit &&/||). Switch variants differ by tool (per-case vs once).

Common ranks: 1–5 A; 6–10 B; 11–20 C; 21–30 D; 31–40 E; 41+ F.
Primary use: testability (minimum paths). Weak on nesting and above-method aggregation.

## Cognitive Complexity (SonarSource / Ann Campbell)

Measures human comprehension cost: +1 per control break; extra for nesting;
else-if chains treated more gently than pure nesting.
Useful thresholds: review around 15; serious concern above 25.
Meaningful at method and higher levels; nesting-aware.

## Halstead

From distinct/total operators and operands: vocabulary, length, volume,
difficulty, effort, estimated bugs ≈ volume/3000.
Secondary signal for “too many concepts.”

## Maintainability Index

Composite of Halstead volume, cyclomatic total, and SLOC (0–100 scale).
Rough bands: >85 strong; 65–85 moderate; <65 hard to maintain.
Dashboard convenience; inspect components when it drops.

## Size and structure

- NLOC / SLOC / LOC — method often ≤30–50; file ≤300–500 as soft guides.
- Nesting depth — prefer ≤3–4.
- Parameter count — prefer ≤4–7.
- CBO / fan-in / fan-out — high values signal coupling risk.
- NPath — path product; very high values imply impractical exhaustive testing.
- CK suite (WMC, DIT, NOC, CBO, RFC, LCOM) for class design.

Project/module view: averages, maxima, distributions, hotspots (complexity × change frequency), debt ratio.
