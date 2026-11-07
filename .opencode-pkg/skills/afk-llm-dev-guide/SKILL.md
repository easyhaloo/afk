---
name: afk-llm-dev-guide
description: >-
  Use when user asks about LLM application design, architecture, skill-driven
  systems, context engineering, HITL, observability, or evolvability.
disable-model-invocation: false
disallowed-tools: null
---

# LLM Development Guide

## Core Decision Tree

```
Is the task outcome enumerable upfront?
├── YES → Workflow + HITL checkpoint
└── NO  → Is failure irreversible/costly?
          ├── YES → Agent + mandatory HITL
          └── NO  → Agent + boundaries
```

## Key Principles

| Domain | Principle |
|--------|-----------|
| Context | Prefix immutable, changes append to tail |
| HITL | density = f(irreversibility x scope x confidence) |
| Prefix | Define perception rules in prefix, changes in tail |
| Tools | Results externalized, context holds only refs |

## References

[Scenario Decision](references/01-scenario-decision.md) — when to use Agent vs Workflow

[HITL Quantization](references/02-hitl-quantitative.md) — checkpoint density and thresholds

[Context Governance](references/03-context-management.md) — tail constraint, external stores

[Observability](references/04-observability.md) — Trace, Audit, Metrics

[Prefix Mutation](references/05-prefix-mutation.md) — changing static prefix without modification

[Module Layout](references/06-module-layout.md) — project structure and layer boundaries

[Prompt Template](references/07-prompt-template.md) — model-agnostic prompt versioning and registry

[Embedding Evolution](references/08-embedding-evolution.md) — embedding model upgrade strategies

[Context Budget](references/09-context-budget.md) — context window abstraction

[LLM Gateway](references/10-llm-gateway.md) — provider abstraction and adapter pattern
