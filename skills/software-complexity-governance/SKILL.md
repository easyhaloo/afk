---
name: software-complexity-governance
description: Detect and govern software complexity at project, module, file, or method level. Use when user asks to measure cyclomatic/cognitive/Halstead complexity, maintainability index, LOC, coupling, or run complexity analysis/detection on codebases, modules, files, or functions. Also covers code smells and their mapping to refactoring patterns. Triggers include complexity检测, 圈复杂度, 认知复杂度, 代码异味, 重构模式, lizard, radon, SonarQube metrics, technical debt from complexity.
---

# Software Complexity Governance Skill

Measure, report, and recommend governance actions for software complexity across scopes: entire project/工程, module/package, file, or single method/function. Also maps detected complexity hotspots to code smells and recommended refactorings.

## Core Metrics (名词与定义)

| Metric | Chinese | Level | Formula / Idea | Typical Thresholds | Purpose |
|--------|---------|-------|----------------|---------------------|---------|
| Cyclomatic Complexity (CC / V(G) / CCN) | 圈复杂度 | Method/Function | Decision points + 1 (if/else/case/for/while/catch/&&/||). Graph: E−N+2P | ≤10 good; 11–20 moderate; >20 high risk; >50 untestable | Testability (min paths to cover) |
| Cognitive Complexity | 认知复杂度 | Method/Function | +1 per control structure; +nesting penalty; sequences of else-if count lightly | ≤15 review; >25 hard to reason | Human readability / maintainability |
| Halstead Metrics | Halstead 度量 | Method/File | n1/n2 distinct ops/operands; N1/N2 totals → Volume V=N·log₂η, Difficulty D, Effort E, Bugs≈V/3000 | Volume high → many concepts; Effort high → hard | Vocabulary size, estimated effort/bugs |
| Maintainability Index (MI) | 可维护性指数 | File/Module | Composite of Halstead Volume + CC + LOC (0–100) | >85 excellent; 65–85 moderate; <65 hard to maintain | Single dashboard score |
| LOC / NLOC / SLOC | 代码行数 | All | Physical / non-comment / source lines | Method ≤30–50; File ≤300–500 | Size sanity check |
| Nesting Depth | 嵌套深度 | Method | Max control-structure nesting | ≤3–4 | Cognitive load |
| Params / Fan-in / Fan-out / CBO | 参数数 / 扇入扇出 / 耦合 | Method/Class | Argument count; incoming/outgoing deps; Coupling Between Objects | Params ≤4–7; high CBO = tangled | Interface & structural complexity |
| NPath | NPath 复杂度 | Method | Number of acyclic paths (exponential with nesting) | >200 impractical to test | Path explosion |

Higher-level (project/module):
- Aggregate averages, max, distribution of above.
- Hotspots: high-CC + high-churn (from git) files.
- Coupling / instability (Ca, Ce, I = Ce/(Ca+Ce)).
- Duplication density, technical-debt ratio (remediation effort / development cost).

## Methodologies & Governance

1. **Measure continuously** — integrate into CI (quality gates on new code). Prefer “Clean as You Code”.
2. **Multi-metric view** — never rely on one number. Pair CC (testability) with Cognitive (readability) + size + coupling.
3. **Thresholds are guidelines** — calibrate per domain (safety-critical stricter). Document exceptions.
4. **Prioritize by pain** — combine static metrics with change frequency (CodeScene-style hotspots).
5. **Refactoring levers** — extract method, reduce nesting, replace conditionals with polymorphism/strategy, split modules, hide complexity behind interfaces. See smells-to-refactorings mapping.
6. **OO extras** — CK suite (WMC, DIT, NOC, CBO, RFC, LCOM) for class design.
7. **Architecture level** — dependency cycles, layer violations, community detection.

## Detection Means (Tools)

Prefer CLI tools runnable in sandbox or user’s environment.

| Scope / Lang | Primary Tool | Command example | Metrics |
|--------------|--------------|-----------------|---------|
| Multi-lang (C/C++/Java/JS/TS/Python/Go/Rust/… 20+) | **lizard** | `lizard <path> -C 15 -a 7 -L 50` | CCN, NLOC, params, tokens; clone detection |
| Python | **radon** | `radon cc <path> -a -s`; `radon mi`; `radon hal`; `radon raw` | CC ranks A–F, MI, Halstead, raw LOC |
| Python cognitive | **complexipy** | `complexipy <path> --max-complexity-allowed 15` | Cognitive complexity |
| JS/TS | ESLint + complexity / sonarjs | `eslint --rule 'complexity: [error, 10]'` | CC; plugins for cognitive |
| Multi (cognitive+CC) | **cccc** (Rust) | `cccc <paths>` | Cognitive + Cyclomatic (TS/JS/Rust/Go/PHP) |
| Full platform | SonarQube / SonarCloud | Server or `sonar-scanner` | CC, Cognitive, MI-like, debt, issues |
| Behavioral | CodeScene | SaaS | Hotspots = complexity × change frequency |

Install tips (sandbox or local):
```bash
pip install lizard radon complexipy
# or npm i -g eslint eslint-plugin-sonarjs
```

For single method/file: feed the source (or extract function) to the tool or compute manually with the rules above.

## Workflow for This Skill

When user requests detection:

1. **Clarify scope** if ambiguous: project root? specific module dir? file path? method name + file?
2. **Detect language(s)** from extensions or user input.
3. **Run appropriate tool(s)** via bash (prefer lizard for multi-lang, radon/complexipy for Python).
   - Project/module: recursive scan, summary + top-N offenders.
   - File: full metrics per function.
   - Method: isolate or filter output.
4. **Report structured**:
   - Summary table (avg / max / distribution / rank).
   - Top offenders with location, metric values, short explanation.
   - Threshold violations highlighted.
   - Map high-complexity items to code smells and recommended refactorings (see references/smells-refactorings.md).
   - Recommended actions (extract, flatten nesting, etc.).
5. **Governance advice**: suggest quality-gate thresholds, CI integration snippet, trend tracking.
6. If no tool available or pure analysis needed, compute from AST/rules or explain formulas.

Always cite sources of thresholds or formulas when quoting industry practice. Prefer actionable output over pure theory.

## References

- Detailed metric formulas & examples → `references/metrics-detail.md`
- Tool command cheat-sheet & sample outputs → `references/tools-cheatsheet.md`
- Governance playbook (thresholds, refactoring patterns) → `references/governance-playbook.md`
- Code smells ↔ refactoring patterns mapping → `references/smells-refactorings.md`
