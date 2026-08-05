# Metrics Detail

## Cyclomatic Complexity (McCabe, 1976)

V(G) = E − N + 2P   (control-flow graph)
Practical: start at 1, +1 for every decision point:
- if, else if, case, while, for, do, catch
- ternary ? :
- logical && || (short-circuit)
- switch often counts as 1 + cases (or modified variant counts switch once)

Rank (common):
- 1–5 A low risk
- 6–10 B
- 11–20 C moderate
- 21–30 D
- 31–40 E high
- 41+ F very high

Limitation: does not penalize nesting; treats sequential ifs same as nested; aggregates poorly above method level.

## Cognitive Complexity (SonarSource / Ann Campbell, 2017)

Goals: better correlate with human understanding.

Rules (simplified):
- +1 for each break in linear flow (if, else, for, while, catch, switch, ternary, logical ops in conditions)
- +1 extra for each nesting level of the above
- else-if / else does not add nesting increment beyond the first if
- sequences of consecutive else-if add only +1 each (no extra nesting)
- recursion, jumps, breaks, continues may add
- modern constructs (lambdas, try-with-resources) handled sensibly

Recommended: flag >15, serious concern >25.

Advantage: meaningful at method, class and even application level; nesting-aware.

## Halstead Metrics (1977)

Four primitives:
- n1 = distinct operators
- n2 = distinct operands
- N1 = total operators
- N2 = total operands

Derived:
- Vocabulary η = n1 + n2
- Length N = N1 + N2
- Volume V = N · log₂(η)
- Difficulty D = (n1/2) · (N2/n2)
- Effort E = D · V
- Time T ≈ E / 18 (seconds)
- Bugs B ≈ V / 3000

Useful secondary signal for “too many concepts juggled”.

## Maintainability Index

Common form (Microsoft / Visual Studio / radon):
MI = max(0, (171 − 5.2·ln(V) − 0.23·G − 16.2·ln(L)) · 100 / 171)
(where V=Halstead volume, G=total CC, L=SLOC; sometimes + comment factor)

0–100 scale. Higher better.

## Other

- NPath: product of branches (exponential).
- Nesting depth: max depth of control structures.
- CK OO suite: WMC (weighted methods = sum CC), CBO, RFC, LCOM, DIT, NOC.
- Fan-in / Fan-out / Information flow complexity (Henry-Kafura).
