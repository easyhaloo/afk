# Documentation Maintenance Audit

**Baseline:** `main` at the start of the documentation refresh (2026-11-03).  
**Rule:** current behavior is grounded in source, command registration, architecture guards, tests, and current architecture docs—not in historical plans or research snapshots.

## Disposition

| Area | Finding | Action |
|---|---|---|
| `docs/product/PRD*.md` | Four product requirement documents were maintained as a parallel requirements corpus inside docs | Removed all four files; docs navigation no longer advertises a PRD library |
| `architecture/execution.md` and `.zh.md` | Described a target/legacy layout including `packages/runtime/src/lib/` and the removed `afk workflow run` entry point | Replaced with a current implementation summary; linked canonical architecture and lifecycle docs |
| `guides/workflows.md` and `.zh.md` | Mixed current managed execution guidance with older scheduler and skill-chain assumptions | Rewritten around the actual `run`, `execute`, `loop`, `qa`, and `observe` boundaries |
| `research/observability-survey-2026-08-02.md` | Historical survey references a former source layout and commands such as `afk scheduler status` and `afk board` | Kept for historical traceability, explicitly marked non-authoritative |
| `superpowers/plans/2026-10-20-outdated-docs-cleanup-plan.md` | Its inventory and migration assumptions are tied to an older baseline | Marked as a historical plan; do not treat its counts or branch assumptions as current |
| `docs/index.md` | Navigation advertised removed PRDs and omitted current entry points and ADR 0020 | Reorganized around current architecture, guides, ADRs, research, and archive |

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
5. `research/` and `_archive/` — historical by nature; do not use them as current architecture facts without source verification.

This audit is a maintenance index, not a substitute for tests or the architecture guard.
