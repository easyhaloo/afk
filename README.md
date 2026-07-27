# AFK

**AFK = Away From Keyboard** — CLI + Skills for autonomous development workflows

Cross-platform issue tracking automation (GitLab/GitHub) powered by Claude AI agents and TypeScript.

## Features

- **Cross-platform** — Unified CLI for GitLab and GitHub (issues, MRs/PRs)
- **Skills Suite** — 15+ Claude Code skills for development workflows
- **TUI Dashboard** — Interactive dashboard for issue tracking
- **Background Automation** — tmux-based workflow scheduler

## Quick Start

```bash
git clone https://github.com/easyhaloo/afk.git
cd afk
./install.sh
afk --version
```

## CLI Commands

```bash
# Issue Management
afk issue get <id>
afk issue list
afk issue create "Title" -d "Body"

# MR/PR Operations
afk mr get <id>
afk mr list
afk mr create "Title" --draft
afk mr merge <id>
afk mr approve <id>

# Workflows & Automation
afk dashboard                         # Interactive TUI
afk workflow run --iid <id>           # Issue → MR pipeline
afk scheduler poll                    # Launch unblocked issues
```

See `afk --help` or [MR Commands](docs/MR_COMMANDS.md) for full reference.

## Skills (Claude Code)

| Skill | Purpose |
|-------|---------|
| `/afk-do` | Task execution (TDD/spike/research) |
| `/afk-implement` | Autonomous issue implementation |
| `/afk-research` | Technical investigation |
| `/afk-grill-me` | Requirements interview |
| `/afk-hand-off` | Session state handoff |

See [Skills Documentation](docs/SKILLS_OPTIMIZATION.md) for full list and usage patterns.

## Development

```bash
npm install
npm run build    # Build TypeScript
npm test         # Run tests
```

See [MR Commands](docs/MR_COMMANDS.md) for cross-platform abstraction details.

## Documentation

- [MR Commands](docs/MR_COMMANDS.md) — Cross-platform MR/PR operations
- [Skills Optimization](docs/SKILLS_OPTIMIZATION.md) — Skills structure and usage

## License

MIT
