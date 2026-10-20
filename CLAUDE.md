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
src/                  # CLI and TUI presentation layer
├── cli/             # Commander wiring, command registry
├── views/           # Ink TUI (core primitives in views/shared/)
├── coordinator/     # Cross-cutting coordination
├── plugin-sdk/      # External plugin contract
├── types/           # Shared board/runtime type projections
└── shared/          # Cross-layer utilities
packages/
├── afk-core/            # Business kernel: models, events, reducer, policy
├── afk-application/     # Use cases and the Port interfaces they are written against
├── afk-infrastructure/  # Provider SDK, git, tracker, claim lock, event store
├── afk-execution/       # Work item execution runtime: workflow, QA, agents, sandbox
└── afk-workflow-graph/  # Deterministic workflow graph algorithms
skills/              # Source of truth for all Claude Code skills
docs/                # All documentation (see below)
```

Layer direction is enforced, not merely documented: `pnpm architecture:check`
rejects illegal relative imports, quarantines legacy files, and refuses a
desktop client that reaches into the root package's `src/` tree. Do not add a
dependency that inverts a layer.

The constraints that govern where code lives, how a module may be moved, and
how the desktop client reaches shared behaviour are in
[`AGENTS.md`](AGENTS.md#package-boundaries) — read them before moving a module
or adding a desktop feature.

## Documentation

[`docs/index.md`](docs/index.md) is the full map. The live areas:

| Area | Path |
| --- | --- |
| Architecture, execution design, glossary | [`docs/architecture/`](docs/architecture/overview.md) |
| Task guides (workflows, skills, testing) | [`docs/guides/`](docs/guides/workflows.md) |
| Architecture decision records | [`docs/adr/`](docs/adr/README.md) |
| Shared execution views and interactive tmux access | [`ADR-0019`](docs/adr/0019-desktop-run-log-viewer-projection.md) |
| Product requirements, research | [`docs/product/`](docs/product/PRD.md), [`docs/research/`](docs/research/) |
| Onboarding | [`docs/getting-started.md`](docs/getting-started.md) |

`docs/_archive/` is a historical holding area, not current guidance. Bilingual
documents ship as `name.md` + `name.zh.md`; update both.

## Conventions

The rules that govern this repository are in
[`AGENTS.md`](AGENTS.md#hard-rules) — the command registry as the CLI source of
truth, work identity as a contract, `skills/` as the source of truth, build
output as non-source, focused tests per extracted unit, and keeping the
documents in lockstep with the code. They are stated once, there, on purpose:
this file is the entry point, and a copy here is a copy that will silently
drift.

## Workflow

```bash
pnpm build              # compile to dist/ (runs workspace package builds first)
pnpm typecheck          # root + workspace typecheck
pnpm test               # vitest + every workspace package
pnpm architecture:check # layer direction + legacy quarantine
pnpm docs:check         # broken doc links + stale source paths the docs name
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
