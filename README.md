# AFK

**AFK = Away From Keyboard** — an autonomous development execution platform for provider-backed work items.

AFK connects issue trackers, code repositories, and coding-agent runtimes. It takes already-decomposed work items through isolated implementation, independent verification, and a human-controlled merge gate.

[中文说明](README.zh.md)

## Architecture

![AFK system architecture](assets/afk-architecture.svg)

AFK is a pnpm workspace with two product entry points — the **CLI/TUI** and **AFK Control Desktop** — sharing the same Core, Application, and Runtime packages. The Runtime composes provider adapters, agent providers, sandbox providers, workflow execution, QA, and local evidence storage.

The diagram reflects the current implementation:

| Area | Responsibility |
| --- | --- |
| `@afk/core` | Pure work-item and execution models, events, reducers, policies, and ports |
| `@afk/application` | Shared use cases, inventory, execution queries, and observation contracts |
| `@afk/runtime` | Workflow orchestration, provider adapters, agent execution, sandboxing, QA, sessions, and persistence |
| `@afk/workflow-graph` | Workflow graph IR, projection, layout, routing, and validation |
| CLI / Desktop | Separate user interfaces over shared packages; Desktop uses typed IPC and a detached Runtime worker |
| Skills | Agent-side playbooks and knowledge workflows; the Wiki skill has its own Python CLI |

AFK consumes work items that have already been decomposed and carry acceptance criteria and relationships. Planning and decomposition remain upstream. The issue tracker remains the authority for backlog state; local inventory and execution records support operation, audit, and observation.

## Features

- **Cross-platform backlog and change management** — GitHub and GitLab providers behind stable contracts
- **CLI + TUI** — command-line operations, interactive dashboard, Kanban, and run observation
- **Desktop control app** — backlog, work items, execution history, workflow views, and operational controls
- **Multi-agent runtime** — Claude Code, Codex, Cursor, OpenCode, Pi, and GitHub Copilot adapters
- **Composable execution environments** — local, Docker, and Podman sandboxes with Git worktrees and process control
- **Independent QA and auditability** — separate verification, execution journals, append-only events, and evidence
- **Skills suite** — reusable research, PRD, implementation, testing, QA, and engineering workflows

## Quick Start

```bash
git clone https://github.com/easyhaloo/afk.git
cd afk
pnpm install
pnpm build
pnpm --dir apps/cli link --global
afk --version
```

See [Getting Started Guide](docs/getting-started.md) for detailed setup.

## Install Claude Code Plugin (Optional)

AFK provides a skill suite that can be installed as a Claude Code plugin.

### Method 1: In Claude Code Session (Recommended)

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
# Backlog management
afk backlog show --id <id>
afk backlog list --state ready --mode afk
afk backlog create "Title" --description-file ./description.md --tag feature
afk backlog tag add --id <id> --tag bug
afk backlog tag remove --id <id> --tag bug

# Execution and automation
afk                                  # Interactive TUI panel
afk kanban                           # Kanban board
afk execute --work-item-id github:owner/repo#123 --execution-manifest <path>
afk observe executions --work-item-id github:owner/repo#123 --json
afk run --backlog-id <id>            # Implementation-stage entry
afk qa --backlog-id <id>             # Standalone QA
afk loop start --daemon --backlog-id <id> --work-item-id github:owner/repo#123 --execution-manifest <path>

# Infrastructure and diagnostics
afk tmux create-session --name <name> --dir <path>
afk isolate up
afk debug reproduce <cmd>
afk signal goal-complete --summary "<summary>"
```

Full command reference: `afk --help`.

## Execution Model

- **`afk run`** runs the implementation stage. On success it publishes the implementation branch and moves the work item to `verification`; it does not by itself complete the managed QA-and-change-request lifecycle.
- **`afk execute`** runs the managed work-item lifecycle: manifest and eligibility checks, implementation, independent QA, change-request creation or verification, and the `merge_ready` human gate.
- **`afk loop`** continuously polls exactly one manifest-bound work item and delegates each attempt to `executeWorkItem`. It is not a global multi-item queue scheduler.
- **Final merge is human-controlled.** AFK prepares and verifies the change request; the work item reaches `done` only after the merge is performed and reconciled.

See [Full Workflow & E2E Architecture](docs/architecture/full-workflow-e2e-architecture.md) for the lifecycle, states, evidence, and verification boundaries.

## Skills (Claude Code)

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `/afk-grill-me` | Requirements interview | Ambiguous requirements or likely gaps |
| `/afk-grill-me-context` | Gap-fill interview | Existing drafts/docs need verification |
| `/afk-to-prd` | Generate PRD | After requirements alignment |
| `/afk-to-issues` | Decompose to issues | After PRD approval |
| `/afk-do` | Task orchestration | Clear feature or task description |
| `/afk-research` | Technical research | Understand the implementation before coding |
| `/afk-prototype` | Validate an approach | Validate a technical approach before committing |
| `/afk-implement` | Implementation workflow | Clear implementation target |
| `/afk-testing` | Testing specialist | Design, execute, diagnose, and assess tests |
| `/afk-change-driven-testing` | Change-driven testing | Add focused regression tests for changed business flows |
| `/afk-qa` | Independent verification | Verify work before merge |
| `/afk-diagnose` | Diagnose failures | Specific, reproducible failures |
| `/afk-branch-migrate` | Cross-branch migration | Cherry-pick between divergent branches |
| `/afk-hand-off` | Work handoff | Transfer work to another developer or session |
| `/afk-scheduler` | Scheduling assistance | Coordinate multiple issues and dependencies |
| `/afk-skill-craft` | Skill authoring | Create, diagnose, or refactor skills |
| `/api-workflow` | API testing | Multi-step API chains with browser testing |
| `/md-to-pdf` | Markdown to PDF | Export Markdown with Mermaid diagrams |
| `/reasoning-guard` | Reasoning guard | Detect multi-turn reasoning degradation |
| `/reasoning-watchdog` | Reasoning monitor | Hooks-based reasoning degradation interception |
| `/afk-ai-prd` | AI-friendly PRD | PRDs that agents can parse, decompose, and verify |
| `/afk-llm-dev-guide` | LLM application guide | LLM architecture and context engineering |
| `/jev-agent-guard` | Agent checkpoints | Install checkpoints across coding agents |
| `/software-complexity-governance` | Complexity governance | Measure complexity, coupling, and technical debt |
| `/wiki` | Knowledge management | Search, read, ingest, and lint project knowledge |

See [Skills Guide](docs/guides/skills.md) for details.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
pnpm --dir apps/desktop test
pnpm --dir apps/cli link --global
```

## Documentation

- **[Getting Started](docs/getting-started.md)** — AFK setup
- **[System Architecture](docs/architecture/system-architecture-design.md)** — system boundaries, layers, control plane, execution substrate, and trust model
- **[Workspace Architecture](docs/architecture/overview.md)** — package boundaries, dependency direction, paths, and provider contracts
- **[Execution Environment](docs/architecture/execution.md)** — agent providers, sandbox providers, sessions, and workflow templates
- **[Full Workflow & E2E](docs/architecture/full-workflow-e2e-architecture.md)** — lifecycle, QA, state transitions, and evidence
- **[Workflows](docs/guides/workflows.md)** — workflow and skill usage
- **[Skills Guide](docs/guides/skills.md)** — skills design and usage
- **[Agent Plugins Compatibility](docs/guides/agent-plugins.md)** — portable Agent Plugins package format

## License

MIT
