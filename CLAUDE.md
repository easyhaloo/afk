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
[`apps/desktop/ARCHITECTURE.md`](apps/desktop/ARCHITECTURE.md).

## Repository layout

```
apps/
├── cli/             # afk executable, Commander commands, completion, Ink TUI
└── desktop/         # Electron main/preload and React renderer
packages/
├── core/            # @afk/core: pure models, events, reducer, ports
├── application/     # @afk/application: shared use cases and queries
├── runtime/         # @afk/runtime: execution engine and Node adapters
└── workflow-graph/  # @afk/workflow-graph: pure graph computation
skills/              # Source of truth for all Claude Code skills
docs/                # All documentation (see below)
```

The root package is a private workspace coordinator. Package responsibilities
and dependency rules are owned by [the architecture overview](docs/architecture/overview.md#workspace-organization).
`pnpm architecture:check` checks runtime layers, public workspace imports and
dependency direction. Do not import another workspace's source by relative path.

## Documentation

[`docs/index.md`](docs/index.md) is the full map. The live areas:

| Area | Path |
| --- | --- |
| Architecture, execution design, glossary | [`docs/architecture/`](docs/architecture/overview.md) |
| Task guides (workflows, skills, testing) | [`docs/guides/`](docs/guides/workflows.md) |
| Architecture decision records | [`docs/adr/`](docs/adr/README.md) |
| Desktop execution and interactive tmux access | [`ADR-0019`](docs/adr/0019-desktop-run-log-viewer-projection.md) |
| Product requirements, research | [`docs/product/`](docs/product/PRD.md), [`docs/research/`](docs/research/) |
| Onboarding | [`docs/getting-started.md`](docs/getting-started.md) |

`docs/_archive/` is a historical holding area, not current guidance. Bilingual
documents ship as `name.md` + `name.zh.md`; update both.

## Conventions

The rules that govern this repository are in
[`AGENTS.md`](AGENTS.md#hard-rules) — the command registry as the CLI source of
truth, work identity as a contract, `skills/` as the source of truth, build
output as non-source, focused tests per extracted unit, the design system for
desktop work, and keeping the documents in lockstep with the code. They are
stated once, there, on purpose: this file is the entry point, and a copy here
is a copy that will silently drift.

## Workflow

```bash
pnpm build              # compile to dist/ (runs workspace package builds first)
pnpm typecheck          # root + workspace typecheck
pnpm test               # shared packages + CLI + repository contract tests
pnpm architecture:check # layer direction + legacy quarantine
pnpm docs:check         # broken/case-mismatched doc links
```

`pretest` runs a build, so `pnpm test` is self-contained. `.husky/pre-push` runs
architecture:check → typecheck → build → test on `main` and `release/*` before
letting a push through. Desktop work is scoped to `apps/desktop/`, whose
packages are built and tested separately — run its own scripts there.
The built executable is `apps/cli/dist/index.js`; `pnpm --filter afk dev --help`
runs the source CLI. `pnpm --filter afk-control-electron build` builds Desktop
and its shared dependencies.

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
