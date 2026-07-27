# AFK

**AFK (Automated Feature Kitchen) — Claude Code skill suite + CLI automation**

Unified workflow automation for GitLab issues → merge requests, powered by Claude AI agents and TypeScript.

## Repository Structure

```
afk/
├── src/                    # afk-cli TypeScript source
│   ├── commands/           # CLI commands (dashboard, gitlab, scheduler, ...)
│   ├── views/dashboard/    # Ink React TUI components
│   └── lib/                # Shared utilities
├── dist/                   # Compiled JavaScript (published to npm)
├── skills/                 # Claude Code skill suite
│   ├── afk-do/             # Task execution workflow
│   ├── afk-research/       # Technical research
│   ├── afk-hand-off/       # Session handoff
│   ├── afk-grill-me/       # Requirements interview
│   └── ...                 # 16 skills total
└── .claude-plugin/         # Claude Code plugin manifest
```

## Quick Install

```bash
git clone https://github.com/easyhaloo/afk.git
cd afk
./install.sh
afk --version
```

## Skills (Claude Code)

| Skill | Usage | Description |
|-------|-------|-------------|
| `/afk-do` | Hitl execution | Task execution with TDD/ spike/ research modes |
| `/afk-research` | Research | Technical investigation with structured findings |
| `/afk-grill-me` | Interview | Requirements gathering — ambiguous → falsifiable |
| `/afk-hand-off` | Handoff | Session context preservation between sessions |
| `/reasoning-guard` | Self-watch | Detect degraded reasoning paths |

Full skill list: `skills/afk-*/SKILL.md`

## CLI Commands

```bash
afk --help                    # Show all commands
afk ui                        # Interactive TUI dashboard
afk workflow launch --iid 123 # Launch issue → MR pipeline
afk scheduler start           # Start background scheduler
afk gitlab get-issue --iid 123
```

## Development

```bash
npm install
npm run build    # tsc + fix-esm-extensions
npm test         # vitest
```

## License

MIT
