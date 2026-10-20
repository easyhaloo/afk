# Getting Started

Get up and running with AFK CLI in 5 minutes.

## Installation

```bash
# Clone the project
git clone https://github.com/easyhaloo/afk.git
cd afk

# Install dependencies
pnpm install

# Build
pnpm build

# Install globally
pnpm link
```

This repository is a pnpm workspace: the root package depends on
`@afk/core`, `@afk/application`, and `@afk/workflow-graph` through the
`workspace:*` protocol, which `npm install` cannot resolve. Use pnpm.

Verify the installation:
```bash
afk --version
afk --help
```

## Configuration

AFK reads its credentials from environment variables, and its project settings
from a YAML file in the project root. There is no global config file and no
`git config afk.*` key.

### GitLab

```bash
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxx
export GITLAB_URL=https://gitlab.company.com   # Optional, defaults to https://gitlab.com
```

When `GITLAB_TOKEN` is absent, AFK falls back to the token stored by the
`glab` CLI in `~/.config/glab-cli/config.yml`.

### GitHub

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx   # GH_TOKEN is also accepted
export GITHUB_REPOSITORY=your-org/your-repo
```

The repository is detected from the git remote; `GITHUB_REPOSITORY` is only
needed when the remote is not reachable.

### Project Settings

Per-project settings live in `.afk/config.yml` at the project root:

```yaml
agentDefault: claude-code
tmuxSession: afk
maxQaReworkAttempts: 3
template: issue-implementation
```

Every key has an environment-variable override, and the project file wins over
the environment. The most useful ones:

| Setting | Environment variable | Default |
|---|---|---|
| `agentDefault` | `AFK_AGENT_DEFAULT` | `claude-code` |
| `tmuxSession` | `AFK_TMUX_SESSION` | `afk` |
| `maxQaReworkAttempts` | `AFK_MAX_QA_REWORK_ATTEMPTS` | `3` |
| `workflowHardTimeout` | `AFK_WORKFLOW_HARD_TIMEOUT` | 7200000 ms |
| `qaTimeout` | `AFK_QA_TIMEOUT` | 1800000 ms |
| `contextThreshold` | `AFK_CONTEXT_THRESHOLD` | 100000 |
| `goalBudget` | `AFK_GOAL_BUDGET` | 10000000 |
| `maxRetries` | `AFK_MAX_RETRIES` | 2 |
| `maxSelfIterations` | `AFK_MAX_SELF_ITERATIONS` | 3 |
| `template` | — (project file only) | `issue-implementation` |

Two variables control where AFK keeps its own state:

| Variable | Meaning |
|---|---|
| `AFK_STATE_DIR` | Durable lease and claim state (default `~/.afk/state`) |
| `AFK_EVENT_STORE_DIR` | Append-only run audit events (default `~/.afk/events`) |

### Platform Auto-Detection

AFK determines the platform and the project from the git remote:

1. Reads `remote.origin.url` of the current repository.
2. A `github.com` remote selects GitHub; any other host selects GitLab.
3. The project is the remote path without the host and without `.git`.

Pass `--platform github` or `--platform gitlab` to any `afk backlog`
command to select the provider explicitly instead.

## Basic Usage

### Backlog Operations

```bash
# View Backlog details
afk backlog show --id 123

# List runnable Backlog items
afk backlog list --state ready --mode afk

# Create a Backlog item
afk backlog create "Add user login" --description-file ./description.md --tag feature

# Execute and verify the same business ID
afk run --backlog-id 123
afk qa --backlog-id 123
```

### Provider Selection

AFK normally detects the provider from the current repository. Backlog
management commands can explicitly select a supported provider when needed:

```bash
afk backlog list --platform github
afk backlog show --id 42 --platform gitlab
```

The provider owns the canonical Backlog ID. AFK creates and merges change
requests as typed workflow steps rather than through a separate public MR command.

### Full Workflow Example

End-to-end flow from Backlog item to merge:

```bash
# 1. Find ready Backlog items
afk backlog list --state ready --mode afk

# 2. Execute one item using its stable business ID
afk run --backlog-id 123

# 3. Monitor Backlog lifecycle and runtime state independently
afk

# 4. Run standalone QA when needed
afk qa --backlog-id 123
```

## Automated Scheduling

Run a manifest-bound work item with the polling daemon:

```bash
afk loop start --daemon --backlog-id <id> \
  --work-item-id github:owner/repo#123 \
  --execution-manifest /absolute/path/to/manifest.json \
  --poll-interval 60
```

The loop requires exactly one backlog ID and a matching execution manifest.
It calls the same `executeWorkItem` use case as `afk execute`; it does not run
the former implementation/QA queue or schedule unrelated items without manifests.

## Next Steps

- **Architecture Design** → [overview.md](architecture/overview.md) — Understand the cross-platform abstraction layer
- **Workflow Details** → [workflows.md](guides/workflows.md) — Deep dive into the three workflow types
- **Skills System** → [skills.md](guides/skills.md) — Learn the design and usage of afk skills
- **Document Map** → [index.md](index.md) — Every document in this repository, and what each one is for

## Troubleshooting

### Command Not Found

```bash
# Re-link
cd /path/to/afk
pnpm link

# Or run directly
node /path/to/afk/dist/index.js --help
```

### Platform Detection Error

AFK could not read a project from the git remote. Check that the repository
has an `origin` remote, or select the provider explicitly:

```bash
afk backlog list --platform gitlab
afk backlog list --platform github
```

### API Permission Error

Make sure your token has sufficient permissions:
- **GitLab**: api, read_api, write_repository
- **GitHub**: repo, workflow

## Need Help?

- Full documentation: `docs/`
- Command help: `afk <command> --help`
- Submit an Issue: https://github.com/easyhaloo/afk/issues
