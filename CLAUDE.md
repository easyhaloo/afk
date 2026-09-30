# AFK — Away From Keyboard

Autonomous development workflow CLI + Claude Code skills suite. Cross-platform
issue tracking (GitLab/GitHub) driven by coding agents.

This file is an **entry point**: it tells you where things are and which
document owns which fact. It deliberately does not restate content — a copy
here is a copy that will silently drift. If you need depth, follow the link.

## Tech stack

TypeScript on Node.js ≥18, pnpm workspaces. CLI via `commander`; TUI via
React + `ink`; validation with `zod`; Git via `simple-git` and `node-tmux`;
GitLab via `@gitbeaker/node`, GitHub via `@octokit/rest`; structured logging
with `pino`. Tests run under `vitest`. The Electron desktop client is a
separate package with its own toolchain — see
[`desktop-client/ARCHITECTURE.md`](desktop-client/ARCHITECTURE.md).

## Repository layout

```
src/
├── domain/          # Pure types, reducers, provider seams — no I/O
├── application/     # Use cases over domain; owns workflow/run state
├── infrastructure/  # Git, tmux, sandboxes, trackers, observability
├── cli/             # Commander wiring, command registry
├── views/           # Ink TUI (core primitives in views/shared/)
├── coordinator/     # Cross-cutting coordination
├── observability/   # Query/projection layer over the audit spine
├── plugin-sdk/      # External plugin contract
├── types/           # Shared board/runtime type projections
└── shared/          # Cross-layer utilities
packages/            # afk-core, afk-application, afk-workflow-graph
skills/              # Source of truth for all Claude Code skills
docs/                # All documentation (see below)
```

Layer direction is enforced, not merely documented: `pnpm architecture:check`
rejects illegal relative imports and quarantines legacy files. Do not add a
dependency that inverts a layer.

## Documentation

[`docs/index.md`](docs/index.md) is the full map. The live areas:

| Area | Path |
| --- | --- |
| Architecture, execution design, glossary | [`docs/architecture/`](docs/architecture/overview.md) |
| Task guides (workflows, skills, testing) | [`docs/guides/`](docs/guides/workflows.md) |
| Architecture decision records | [`docs/adr/`](docs/adr/README.md) |
| Product requirements, research | [`docs/product/`](docs/product/PRD.md), [`docs/research/`](docs/research/) |
| Onboarding | [`docs/getting-started.md`](docs/getting-started.md) |

`docs/_archive/` is a historical holding area, not current guidance. Bilingual
documents ship as `name.md` + `name.zh.md`; update both.

## Conventions

- **The command registry is the single source of truth for the CLI surface.**
  The supported commands, and the absence of aliases for removed groups, are
  documented in
  [docs/architecture/overview.md](docs/architecture/overview.md). If you change
  a signature, a flag, or remove a command, update that table in the same
  commit — do not add a second command list here.
- **Work identity is a contract, not a convention you may redefine.** The
  `BacklogItem.id` / `Run.workItemId` / `runId` / `parentId` / `dependsOn` /
  `baseBacklogId` distinctions, and the rules for status ownership, are
  specified in
  [docs/architecture/overview.md](docs/architecture/overview.md#work-item-and-execution-identity).
  Read it before touching run, backlog, or runtime code.
- **`skills/` is the source of truth.** Never edit skills under
  `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/` — those are
  installed copies and edits are lost on reinstall. See
  [`skills/SKILL-GUIDE.md`](skills/SKILL-GUIDE.md) for authoring standards.
- **Build output is not source.** `dist/`, `dist-electron/`, `release/`, and
  test screenshots are generated. Do not review, edit, or commit them.
- **Add focused tests** for every extracted service or pure function. Each
  workspace package must pass its own typecheck, build, and test — a green
  root run must not mask a broken package.
- **Docs stay in lockstep with code.** The link checker (`pnpm docs:check`) only
  catches broken links; stale *prose* is on you. When a module moves, grep the
  docs for the old path.

## Workflow

```bash
pnpm build              # compile to dist/ (runs workspace package builds first)
pnpm typecheck          # root + workspace typecheck
pnpm test               # vitest + @afk/core + @afk/application
pnpm architecture:check # layer direction + legacy quarantine
pnpm docs:check         # broken/case-mismatched doc links
```

`pretest` runs a build, so `pnpm test` is self-contained. `.husky/pre-push` runs
architecture:check → typecheck → build → test on `main` and `release/*` before
letting a push through. Desktop work is scoped to `desktop-client/`, whose
packages are built and tested separately — run its own scripts there.

## Environment

```bash
GITLAB_TOKEN=          # GitLab API token
GITLAB_URL=            # GitLab instance URL
GITHUB_TOKEN=          # GitHub API token
AFK_TMUX_SESSION=      # tmux session name (default: afk)
```

## Related projects

| Project | Path | Purpose |
| --- | --- | --- |
| afk-plugin | `~/.claude/plugins/cache/afk/` | Installed copy of this repo's skills |

The repo's `skills/` directory is the editable original; the cache above is
only what Claude Code loads at runtime.
