# Documentation Maintenance Audit

**Baseline:** `main` at the start of the documentation refresh (2026-11-03).  
**Rule:** current behavior is grounded in source, command registration, architecture guards, tests, and current architecture docs—not in historical plans or research snapshots.

## Disposition

| Area | Finding | Action |
|---|---|---|
| `docs/product/PRD*.md` | Four product requirement documents were maintained as a parallel requirements corpus inside docs | Removed all four files; docs navigation no longer advertises a PRD library |
| `architecture/execution.md` and `.zh.md` | Described a target/legacy layout including `packages/runtime/src/lib/` and the removed `afk workflow run` entry point | Replaced with a current implementation summary; linked canonical architecture and lifecycle docs |
| `guides/workflows.md` and `.zh.md` | Mixed current managed execution guidance with older scheduler and skill-chain assumptions | Rewritten around the actual `run`, `execute`, `loop`, `qa`, and `observe` boundaries |
| `architecture/blueprints/` | Contained completed implementation blueprints, superseded directory proposals, and a naming changelog tied to a completed refactor | Removed the directory contents; current package structure and decisions belong in the canonical architecture overview, source, tests, and ADRs |
| `research/` | Mixed AFK-relevant but dated CLI comparison with unrelated one-off investigations, speculative research, obsolete observability survey, and a duplicate HTML export | Retained only the bilingual Agent CLI comparison; removed unrelated/one-off material and duplicate formats |
| `docs/index.md` | Navigation advertised obsolete blueprint and research links, removed PRDs, and omitted current entry points and ADR 0020 | Updated navigation to link only to retained, maintained material |

## Canonical sources

- **Current package boundaries and command surface:** [Architecture Overview](overview.md), plus the source registry at `apps/cli/src/command-registry.ts`.
- **Managed execution lifecycle and verification evidence:** [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md).
- **Run events, audit, and evidence:** [Observability](observability.md) and ADR 0016–0018.
- **Architecture decisions:** [ADR index](../adr/README.md).
- **User-facing CLI examples:** [Getting Started](../getting-started.md) and the command registry.

## Known follow-up review targets

These documents should be reviewed against current source before being treated as implementation contracts:

1. `architecture/system-architecture-design.md` — retain as architecture rationale, but check aspirational language against the implemented package graph.
2. `architecture/afk-architecture-handbook.md` and its PDF — duplicate/derived architecture narrative; decide whether to keep one generated artifact or remove the redundant copy after link/reference checks.
3. `architecture/full-workflow-e2e-architecture.md` — detailed and evidence-rich; periodically refresh dated test runs, artifact paths, and runtime examples.
4. `guides/testing.md` and `.zh.md` — validate commands and test-tree examples against root scripts and current test configuration.
5. `research/agent-cli-comparison.md` and `.zh.md` — dated tool-version snapshot; refresh claims and measurements before using it to make current tool-selection decisions.
6. `_archive/` — historical material only; do not use it as current architecture facts without source verification.

This audit is a maintenance index, not a substitute for tests or the architecture guard.
