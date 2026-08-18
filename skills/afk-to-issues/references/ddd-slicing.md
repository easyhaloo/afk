# Task Slicing Strategy

Use this reference when deciding how a PRD should be decomposed into executable backlog items.

## Core Principle

**Choose the slicing strategy from the work, not from the repository's directory structure.** Prefer vertical slices for coherent business outcomes, use horizontal slices for foundational or inherently technical work, and combine them when a shared foundation enables multiple independent capabilities.

## Vertical Slicing — Preferred for Capabilities

A vertical slice contains the changes required to deliver one coherent outcome. It may cross domain, application, API, UI, persistence, and test layers.

```text
Document permission inheritance
├── permission rules
├── API behavior
├── persistence changes
├── UI behavior
└── tests
```

Use vertical slicing when:

- the item represents a user story or business capability;
- the outcome can be independently accepted;
- one execution unit can own the required cross-layer changes; or
- end-to-end verification is meaningful.

Do not create separate issues merely for controller, service, repository, or UI files.

## Horizontal Slicing — Purposeful for Foundations

Use horizontal slicing when the work is inherently technical or has unavoidable sequencing:

- database/schema migrations;
- shared infrastructure;
- framework or SDK changes;
- reusable platform components;
- large refactors;
- compatibility or migration foundations.

A horizontal task must still have a coherent responsibility and verification boundary. Repository layers alone are not sufficient justification.

```text
Permission foundation
├── schema migration
├── shared permission model
└── evaluation engine
```

## Hybrid Slicing

Use hybrid slicing when foundational work enables multiple independently deliverable capabilities.

```text
Foundation
├── permission model
└── permission engine

Capabilities
├── permission API
├── permission UI
└── inheritance behavior

Integration
└── end-to-end verification
```

Foundations should be prerequisites only when the capability genuinely depends on them. Independent capabilities should remain parallelizable.

## Bounded Contexts

Bounded contexts are a useful boundary, not an absolute rule.

- Prefer keeping a capability within one bounded context when practical.
- Split cross-context work when ownership, sequencing, or verification requires independent items.
- Keep a cross-context item together when the outcome is genuinely one executable integration change and splitting would create artificial coordination overhead.
- Model real cross-context dependencies explicitly.

## Dependency Rules

If task B consumes a contract, schema, event, or behavior produced by task A, B should depend on A only when A must be completed first.

Do not create dependencies solely because:

- two tasks touch the same module;
- two tasks belong to the same PRD story;
- one task is conceptually related to another.

The final dependency graph must be acyclic and should expose the earliest executable tasks and safe parallel groups.

## Task Boundary Test

A candidate task is a good backlog boundary when all three are true:

1. **Coherent responsibility** — it has one clear outcome or implementation boundary.
2. **Independent execution** — it can proceed without unrelated incomplete work except declared prerequisites.
3. **Independent verification** — completion can be demonstrated with concrete evidence.

Merge tasks when they cannot satisfy these conditions independently. Split tasks when they are too broad to have a coherent acceptance boundary.

## Anti-Patterns

- Do not split every layer into a separate issue by default.
- Do not force every issue into one bounded context.
- Do not create a single giant issue for an entire PRD when capabilities can be independently delivered.
- Do not create one issue per method, class, or file.
- Do not introduce dependencies without an actual execution constraint.
- Do not invent architecture solely to make the task graph look cleaner.
