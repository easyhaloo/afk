# AFK — Away From Keyboard

Autonomous development workflow CLI + Claude Code skills suite. Cross-platform
issue tracking (GitLab/GitHub) driven by coding agents.

This file is an **entry point**: it tells you where things are and which
document owns which fact. It deliberately does not restate content — a copy
here is a copy that will silently drift. If you need depth, follow the link.

## Tech stack

TypeScript on Node.js ≥22.16, pnpm workspaces. CLI via `commander`; TUI via
React + `ink`; validation with `zod`; Git via `simple-git` and `node-tmux`;
GitLab via `@gitbeaker/node`, GitHub via `@octokit/rest`; structured logging
with `pino`. Tests run under `vitest`. The Electron desktop client is a
separate package with its own toolchain — see
[`apps/desktop/architecture.md`](apps/desktop/architecture.md).

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
| Product requirements, research | [`docs/product/`](docs/product/PRD.md), [`docs/product/PRD-work-items-reverse-sort-2026-10-15.md`](docs/product/PRD-work-items-reverse-sort-2026-10-15.md), [`docs/research/`](docs/research/) |
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
- **Skill changes require a plugin version bump.** When adding or changing a
  skill (including its scripts and references), update `version` in
  [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) in the same commit.
  Increment at least the patch version; use a minor or major bump when the
  release requires it.
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
AFK_WORKSPACE=         # Desktop project selection; does not relocate execution or system data
AFK_TRACKER_PROJECT=   # Provider project fallback when cwd has no git remote
AFK_TRACKER_PLATFORM=  # Provider platform fallback (github|gitlab)
AFK_TMUX_SESSION=      # tmux session name (default: afk)
```

CLI and Desktop execute under `~/.loop-workspace/`, isolated by work-item ID.
Configuration and system data live under `~/.afk/`: `config.yml`, `workflows/`,
`tracker-projects.json`, runtime records, and per-workspace data in
`workspaces/<sha256-of-absolute-workspace-path>/`. See
[workspace paths](docs/architecture/overview.md#execution-and-system-paths).

## Related projects

| Project | Path | Purpose |
| --- | --- | --- |
| afk-plugin | `~/.claude/plugins/cache/afk/` | Installed copy of this repo's skills |

The repo's `skills/` directory is the editable original; the cache above is
the installed plugin copy. For direct source loading of `/wiki` and its live
Claude Code integration test, see the [wiki integration guide](docs/guides/skills.md#claude-code-integration).
