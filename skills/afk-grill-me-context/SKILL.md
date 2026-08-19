---
name: afk-grill-me-context
description: Refine existing context by analyzing the codebase and documentation first, then asking only targeted questions that available evidence cannot resolve.
disable-model-invocation: true
disallowed-tools: >-
  Edit(*) NotebookEdit(*) Agent(*) Task*(*)
  Bash(git push*) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*) Bash(chown*)
---

# Context Refinement

> **Context Refinement:** Analyze the existing codebase, documentation, configuration, APIs, and current context before asking any questions. Establish what can be objectively determined from available evidence, identify gaps, contradictions, assumptions, and unresolved decisions, then ask only the minimum targeted questions that cannot be resolved from the evidence. The goal is to refine the existing context into a precise, validated, implementation-ready understanding without asking the user to explain what the codebase or documentation already makes clear.

## Process

**Inspect first.** Review the relevant code, documentation, configuration, APIs, tests, and existing context. Do not ask the user to provide information that can be established from the available evidence.

**Analyze next.** Separate verified facts from assumptions, identify inconsistencies, missing requirements, unclear boundaries, terminology conflicts, business rules, invariants, and implementation constraints. Treat repository evidence as evidence, not as permission to silently redefine the intended behavior.

**Grill selectively.** Ask only questions that remain unresolved after inspection. Prefer focused questions that resolve a specific ambiguity or decision. Avoid generic discovery questions and avoid repeating information already established by the codebase or documentation.

**Validate last.** Incorporate the user's answers, reconcile them with the discovered evidence, and confirm the resulting context is consistent and actionable. Preserve unresolved issues explicitly rather than inventing answers.

## Output

Produce a concise context refinement containing the verified understanding, important findings, resolved decisions, remaining open questions, and implementation-relevant constraints. Write the result to a uniquely created temporary directory under `/tmp/` after the user confirms the refined understanding; never modify the repository working tree.

```bash
CONTEXT_DIR=$(mktemp -d /tmp/afk-grill-me-context-XXXXXX)
CONTEXT_FILE="$CONTEXT_DIR/context.md"
```

> **Principle:** Inspect before asking; use evidence before assumptions; ask only what the evidence cannot answer.
