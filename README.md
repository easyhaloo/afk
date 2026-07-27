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

### Issue Management
```bash
afk issue get <id>                    # Get issue details
afk issue list                        # List issues
afk issue create "Title" -d "Body"    # Create issue
afk issue update-labels <id> -a bug   # Add label
```

### MR/PR Management
```bash
afk mr get <id>                       # Get MR/PR details
afk mr list                           # List MRs/PRs
afk mr create "Title" --draft         # Create draft MR/PR
afk mr merge <id>                     # Merge MR/PR
afk mr approve <id>                   # Approve MR/PR
afk mr close <id>                     # Close MR/PR
```

### Dashboard & Workflows
```bash
afk dashboard                         # Interactive TUI
afk workflow run --iid <id>           # Launch issue → MR pipeline
afk scheduler poll                    # Poll and launch unblocked issues
```

## Skills (Claude Code)

| Skill | Description |
|-------|-------------|
| `/afk-do` | Execute coding tasks with TDD/spike/research modes |
| `/afk-implement` | Autonomous issue implementation (background) |
| `/afk-research` | Technical investigation with structured findings |
| `/afk-grill-me` | Requirements interview (ambiguous → falsifiable) |
| `/afk-hand-off` | Session state handoff for zero-context-loss resume |
| `/afk-qa` | Quality assurance workflow with AC verification |
| `/afk-prototype` | Spike workflow for feasibility exploration |
| `/afk-scheduler` | Dependency-aware parallel issue execution |

See [docs/SKILLS_OPTIMIZATION.md](docs/SKILLS_OPTIMIZATION.md) for details.

## Project Structure

```
afk/
├── src/
│   ├── commands/        # CLI commands
│   ├── lib/
│   │   └── core/
│   │       ├── tracker/ # Cross-platform abstraction
│   │       ├── gitlab/  # GitLab client
│   │       └── github/  # GitHub client
│   └── views/           # TUI components (Ink React)
├── dist/                # Compiled output
└── docs/                # Documentation
```

## Development

```bash
npm install
npm run build    # Build TypeScript
npm test         # Run tests
```

## Documentation

- [MR Commands](docs/MR_COMMANDS.md) — Cross-platform MR/PR operations
- [Skills Optimization](docs/SKILLS_OPTIMIZATION.md) — Skills structure and usage
- [Architecture](docs/ARCHITECTURE.md) — System design (if exists)

## License

MIT
