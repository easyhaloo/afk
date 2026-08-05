# Tools Cheat-sheet

Intent: pick an analyzer that matches language and required metrics.
Do not treat command lines below as mandatory copy-paste; adapt to the environment.

## Multi-language structural (cyclomatic, NLOC, params)

**lizard** — broad language set (C/C++, Java, JS/TS, Python, Go, Rust, and more).
Use for mixed trees or when one CLI is preferred. Supports thresholds and clone detection.

## Python

**radon** — cyclomatic ranks, maintainability index, Halstead, raw size metrics.
**complexipy** — cognitive complexity focused.

## JavaScript / TypeScript

ESLint complexity rule; SonarJS or similar plugins for cognitive complexity when available.

## Multi-language cognitive + cyclomatic

**cccc** (and similar AST-based CLIs) when both metrics are required in one pass
for supported languages (e.g. TS/JS, Go, Rust, PHP).

## Platforms

SonarQube / SonarCloud — project-level complexity, cognitive, debt, quality gates.
CodeScene-style tools — behavioral hotspots (complexity × change frequency).

## Fallback

If no analyzer is available, apply counting rules from metrics-detail.md to the
provided source (or AST) and state the limitation clearly.
