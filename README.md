# AFK

**AFK = Away From Keyboard** — Autonomous development workflow CLI + Skills system

Cross-platform issue tracking automation (GitLab/GitHub) powered by Claude AI agents and TypeScript.

[中文说明](README_zh.md)

## Architecture

![AFK Architecture](assets/afk-architecture.jpg)

## Features

- **Cross-platform** — Unified GitLab and GitHub CLI (issues, MRs/PRs)
- **Skills Suite** — 19 Claude Code skills covering the full development lifecycle
- **TUI Dashboard** — Interactive issue tracking dashboard
- **Background Automation** — tmux-based workflow scheduler
- **TDD Integration** — Built-in test-driven development methodology

## Quick Start

```bash
git clone https://github.com/easyhaloo/afk.git
cd afk
npm install && npm run build
npm link
afk --version
```

See [Getting Started Guide](docs/GETTING-STARTED.md) for detailed setup.

## Install Claude Code Plugin (Optional)

AFK provides a full Claude Code skill suite that can be integrated as a plugin.

### Method 1: In Claude Code Session (Recommended)

Use the slash command directly in Claude Code:

```bash
/plugin install afk@afk
```

### Method 2: Using CLI

```bash
# Add marketplace
claude plugin marketplace add easyhaloo/afk --scope user

# Install plugin
claude plugin install afk@afk
```

### Method 3: settings.json Configuration

Add to Claude Code's `settings.json` (global or project-level `.claude/settings.json`):

```json
{
  "extraKnownMarketplaces": {
    "afk": {
      "source": {
        "source": "github",
        "repo": "easyhaloo/afk"
      }
    }
  }
}
```

Supported `source` types:
- `"github"` — Load from GitHub repository
- `"local"` — Load from local filesystem

### Method 4: Symlink Skills

Link the `skills/` directory to the global skills directory:

```bash
mkdir -p ~/.claude/skills
ln -s /path/to/afk/skills/* ~/.claude/skills/
```

### Verify Installation

Run `/afk-grill-me` in Claude Code to confirm skills are loaded.

## CLI Commands

```bash
# Backlog Management
afk backlog show --id <id>
afk backlog list --state ready --mode afk
afk backlog create "Title" --description-file ./description.md --tag feature
afk backlog tag add --id <id> --tag bug
afk backlog tag remove --id <id> --tag bug

# Execution & Automation
afk                                  # Interactive TUI panel
afk kanban                           # Kanban board
afk run --backlog-id <id>            # Execute one Backlog item
afk run --backlog-id <id> --project <repo>
afk qa --backlog-id <id>             # Standalone QA
afk loop start --daemon --max-concurrent 3

# Infrastructure
afk tmux create-session --name <name> --dir <path>
afk isolate up

# Debug
afk debug reproduce <cmd>

# Signal Management
afk signal goal-complete --summary "<summary>"
```

Full command reference: `afk --help`

## Skills (Claude Code)

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `/afk-grill-me` | Requirements interview | Ambiguous requirements or likely gaps |
| `/afk-grill-me-context` | Gap-fill interview | Existing drafts/docs need verification |
| `/afk-to-prd` | Generate PRD | After requirements alignment |
| `/afk-to-issues` | Decompose to issues | After PRD approved |
| `/afk-do` | Task orchestration | Clear feature or task description |
| `/afk-research` | Technical research | Need to understand existing implementation before coding |
| `/afk-prototype` | Validate approach | Need to validate tech approach before committing |
| `/afk-implement` | TDD implementation | Clear implementation target |
| `/afk-qa` | Independent verification | MR/PR ready to merge |
| `/afk-diagnose` | Quick fix | Specific, reproducible failure |
| `/afk-pipeline` | Phase routing | Unsure which skill to use |
| `/afk-branch-migrate` | Cross-branch migration | Cherry-pick between divergent branches |
| `/afk-hand-off` | Work handoff | Transfer task to another developer |
| `/afk-scheduler` | Background scheduling | Multiple issues with dependency-aware execution |
| `/afk-skill-craft` | Skill authoring | Create, diagnose, or refactor skills |
| `/api-workflow` | API testing | Multi-step API chains with browser testing |
| `/md-to-pdf` | Markdown to PDF | Export docs with Mermaid diagrams |
| `/reasoning-guard` | Reasoning guard | Multi-turn reasoning degradation in coding agents |
| `/reasoning-watchdog` | Auto reasoning monitor | Hooks-based automatic reasoning degradation interception |

See [Skills Guide](docs/SKILLS.md) for detailed documentation.

## Architecture

AFK uses **TrackerProvider** interface to abstract GitLab and GitHub differences:

```typescript
interface TrackerProvider {
  getIssue(id: number): Promise<TrackedIssue>;
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
  // ... more operations
}
```

Platform auto-detected, no command switching needed. See [Architecture Design](docs/ARCHITECTURE.md) and [Execution Environment Design](docs/EXECUTION-DESIGN.md).

## Workflows

Three core workflow patterns:

1. **Issue → Implementation → MR Pipeline** — From issue discovery to merge request
2. **Scheduler Workflow** — Background dependency-aware execution
3. **Skills Workflow** — TDD methodology integration

See [Workflow Documentation](docs/WORKFLOWS.md).

## Development

```bash
npm install
npm run build    # Build TypeScript
npm test         # Run tests
npm link         # Install globally
```

## Documentation

- **[Getting Started](docs/GETTING-STARTED.md)** — 5-minute AFK setup
- **[Architecture Design](docs/ARCHITECTURE.md)** — Cross-platform abstraction + CLI command mapping
- **[Workflows](docs/WORKFLOWS.md)** — Issue → MR pipeline, scheduler, Skills integration
- **[Skills Guide](docs/SKILLS.md)** — Core skills design and usage

## License

MIT
