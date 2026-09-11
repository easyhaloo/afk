# AFK — Away From Keyboard CLI

Autonomous development workflow CLI + Skills system.

## Project Overview

AFK is a CLI tool for managing autonomous development workflows, particularly focused on GitLab/GitHub integration, tmux session management, and a TUI-based dashboard.

**Tech Stack**: TypeScript, React (Ink), Node.js ≥18

## Key Commands

| Command | Purpose |
|---------|---------|
| `afk backlog` | Backlog management and inspection only |
| `afk backlog --json` | Emit structured JSON envelopes on stdout (used by the AFK Control desktop client) |
| `afk run --backlog-id <id>` | Execute one backlog item |
| `afk loop` | Complete implementation → QA → merge pipeline |
| `afk qa --backlog-id <id>` | Standalone QA retry/diagnostic entry point |
| `afk loop` | Continuous integration loop |
| `afk qa` | QA verification on merged code |
| `afk signal` | Structured signal file management |
| `afk worktree` | Git worktree management with state tracking |
| `afk tmux` | Tmux session management |
| `afk isolate` | DB service isolation per worktree |
| `afk escalate` | File GitLab issue and launch workflow |
| `afk board` | Interactive TUI dashboard |
| `afk kanban` | Kanban board of issues |
| `afk debug` | Debug loop (reproduce → verify) |

## Desktop Client

From the repository root, use the `Makefile` for common desktop-client commands:

```makefile
make desktop-dev        # build + restart (always uses latest code)
make desktop-build      # typecheck + compile
make desktop-test       # vitest unit tests
make desktop-e2e        # build:main + Playwright e2e
make desktop-package-mac  # package .app to release/
make desktop-verify-mac   # restart-packaged-mac verification
```

Alternatively, `pnpm --filter afk-control-electron <cmd>` from `desktop-client/`.

The CLI is a breaking backlog hard cutover. `issue`, `tracker`, `mr`, and
`workflow` execution commands and their old argument forms are removed; there
are no compatibility aliases. Provider labels are internal adapter metadata.

## Architecture

```
src/
├── cli/                # CLI command implementations
├── domain/             # Domain models and provider contracts
├── application/        # Workflow, module, and runtime orchestration
├── infrastructure/     # Git, tracker, tmux, IO adapters
├── views/              # React + Ink TUI
│   ├── app/            # Dashboard composition and state
│   ├── board/          # Built-in views and navigation
│   └── plugins/        # External TUI plugin contract and loader
└── index.ts            # Entry point
```

### External TUI Plugins

Trusted local plugins are discovered from `~/.afk/plugins.yml` and loaded from
`~/.afk/plugins/<id>/dist/index.js` when enabled. A plugin exports a default
object or named `plugin` object with `id`, `name`, and `views`; each view has an
`id`, `title`, `shortcut`, and `render(context)` function. View IDs are
namespaced as `plugin:<plugin-id>:<view-id>`.

Built-in views and shortcuts always win conflicts. Invalid or failing plugins
are skipped without preventing TUI startup. These plugins are trusted local
code and run with the same account permissions as AFK; the loader does not
provide a sandbox.

## Related Projects

| Project | Path | Purpose |
|---------|------|---------|
| afk-plugin | `~/.claude/plugins/cache/afk/` | Claude Code skill plugins |

## Workflow

1. Make changes in `src/`
2. Run `pnpm build` to compile to `dist/`
3. Test with `pnpm test` (vitest)
4. For TUI testing, see [docs/TESTING.md](docs/TESTING.md)
5. **Documentation sync**: CLI command changes (signature, flags, behavior) or skill modifications must update the corresponding docs — `README.md`, `CLAUDE.md` command table, skill docs, or related `docs/` files. Keep docs in lockstep with code.

### desktop-client end-to-end

`desktop-client/` ships a Playwright Electron suite in addition to its vitest unit tests:

- `pnpm --filter afk-control-electron test` — vitest, covers shared contracts, IPC handlers, services, component-level E2E with react-test-renderer.
- `pnpm --filter afk-control-electron build:main` — compile `electron/` to `dist-electron/` (required before E2E).
- `pnpm --filter afk-control-electron e2e` — Playwright `_electron.launch()` boots the real Electron window against the Vite dev server; `tests/e2e/fixtures/fake-afk.mjs` intercepts the CLI subprocess on `PATH` so the tests run without GitHub / GitLab auth.

The E2E suite must always boot its own Vite — never `reuseExistingServer`, because a stale Vite from a different checkout will serve the wrong source. Linux CI uses `xvfb-run` to provide a display server; see `.github/workflows/ci.yml` job `desktop-e2e`.

## Skill Development

When modifying or creating skills, always work in the project's `skills/` directory:
- **Do not** edit skills in `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/`
- The project's `skills/` directory is the source of truth
- Changes should be committed and pushed from here
- See `skills/SKILL-GUIDE.md` for skill authoring standards
- Use `afk-skill-craft` to create, diagnose, or refactor skills

## Environment

```bash
# Required env vars for full functionality
GITLAB_TOKEN=     # GitLab API token
GITLAB_URL=       # GitLab instance URL
GITHUB_TOKEN=     # GitHub API token
TMUX_SESSION=     # tmux session name (default: afk)
```

## Desktop Electron Architecture

The `desktop-client/` package is an Electron application with three explicit
runtime layers: `electron/` (main process), `electron/preload.ts` (bridge),
and `src/` (React renderer). Keep these boundaries strict:

- `electron/main.ts` is bootstrap only. Window creation, IPC registration,
  services, adapters, and workflow parsing belong in their respective modules.
- The renderer must not import `electron`, Node built-ins, filesystem APIs,
  child-process APIs, SQLite, or YAML parsers.
- The preload exposes a typed, fixed whitelist from `desktop-client/shared/`.
  It must not expose generic shell, filesystem, eval, or arbitrary IPC APIs.
- Every IPC handler validates its sender frame and all arguments in the main
  process. Production windows load packaged local assets only; navigation,
  new-window, and permission requests are denied by default.
- Shared DTOs and validation types live in `desktop-client/shared/` and must be
  free of Node, Electron, React, DOM, and filesystem dependencies.
- Workflow graph layout, routing, normalization, and validation are pure
  functions outside React. Invalid dependencies and cycles return diagnostics;
  they must never be represented as `undefined` nodes.
- YAML is parsed through one schema-aware parser. Do not maintain a second
  line-oriented parser for the same configuration.
- Every extracted service and graph function gets focused tests. The desktop
  package must expose `typecheck`, `build`, and `test` scripts and be covered by
  CI independently of the root CLI.
- `dist/`, `dist-electron/`, `release/`, and screenshot/test-artifact output are
  generated files and must not be treated as source modules or committed as
  implementation changes.

## Execution Architecture Status

All 8 phases of [docs/EXECUTION-DESIGN.md](docs/EXECUTION-DESIGN.md) are implemented:

| Phase | Module | Notes |
|-------|--------|-------|
| 0 | `agents/types.ts`, `sandbox/types.ts` | Interfaces only |
| 1 | `sandbox/local.ts`, `sandbox/types.ts` | Local sandbox wired into `WorkflowRunner` |
| 2 | `sandbox/local.ts` (LocalAgentExecution), `agents/claude-code.ts` | ExecutionResult.status + LegacyExecutionWrapper for tests |
| 3 | `agents/{codex,cursor,pi,opencode,copilot}.ts`, `agents/registry.ts` | 6 providers + capability-gated resume |
| 4 | `sessions/{types,file-store,handoff-store,run-state}.ts` | SessionStore chain + atomic writes + checksum |
| 5 | `sandbox/container/*` | Docker + Podman sandbox with env allowlist |
| 6 | `branches/{issue,named,merge-to-head,existing}.ts` | 4 strategies + parallel-worktree isolation |
| 7 | `templates/*` | 5 builtin templates + zod-validated loader |
| 8 | `sandbox/legacy-compat.ts` | `.afk-signal.json` is legacy fallback only |

`.afk-signal.json` (the legacy completion protocol) is deprecated — see `core/io/signal.ts` JSDoc and `sandbox/legacy-compat.ts`. New agents report via ExecutionResult; old worktrees are still readable.
