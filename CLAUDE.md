# AFK — Away From Keyboard CLI

Autonomous development workflow CLI + Skills system.

## Project Overview

AFK is a CLI tool for managing autonomous development workflows, particularly focused on GitLab/GitHub integration, tmux session management, and a TUI-based dashboard.

**Tech Stack**: TypeScript, React (Ink), Node.js ≥18

## Key Commands

| Command | Purpose |
|---------|---------|
| `afk board` | TUI dashboard with view registry |
| `afk qa` | QA runner for MRs |
| `afk scheduler` | Background task scheduler |
| `afk signal` | Signal-based task trigger |
| `afk tracker` | Issue/mr management |

## Architecture

```
src/
├── commands/          # CLI command implementations ( commander )
├── lib/
│   ├── ui/core/       # TUI core: View, Registry, Keyboard
│   ├── core/          # GitLab, GitHub, Tracker, IO abstractions
│   └── plugins/       # Skill loader
└── index.ts           # Entry point
```

### TUI Core (`src/lib/ui/core/`)

- **View** — Interface for TUI panels; each View has `id`, `shortcut`, `render()`
- **ViewRegistry** — Manages View registration and active state; sorts by priority
- **KeyboardDispatcher** — Routes keyboard events to global handlers or active View

TUI built with React + Ink. Components live in `src/components/` (planned).

## Related Projects

| Project | Path | Purpose |
|---------|------|---------|
| afk-plugin | `~/.claude/plugins/cache/afk/` | Claude Code skill plugins |

## Workflow

1. Make changes in `src/`
2. Run `pnpm build` to compile to `dist/`
3. Test with `pnpm test` (vitest)
4. For TUI testing, see [docs/TESTING.md](docs/TESTING.md)

## Skill Development

When modifying or creating skills, always work in the project's `skills/` directory:
- **Do not** edit skills in `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/`
- The project's `skills/` directory is the source of truth
- Changes should be committed and pushed from here

## Environment

```bash
# Required env vars for full functionality
GITLAB_TOKEN=     # GitLab API token
GITLAB_URL=       # GitLab instance URL
GITHUB_TOKEN=     # GitHub API token
TMUX_SESSION=     # tmux session name (default: afk)
```
