# Getting Started

Get up and running with AFK CLI in 5 minutes.

## Installation

```bash
# Clone the project
git clone https://github.com/easyhaloo/afk.git
cd afk

# Install dependencies
npm install

# Build
npm run build

# Install globally
npm link
```

Verify the installation:
```bash
afk --version
afk --help
```

## Configuration

### GitLab Project

Create a config file at `~/.config/afk/.env`:

```bash
# GitLab configuration
GITLAB_TOKEN=glpat-xxxxxxxxxxxxx
GITLAB_BASE_URL=https://gitlab.company.com/api/v4  # Optional, defaults to gitlab.com

# Or use git config (recommended)
cd /path/to/your/project
git config afk.platform gitlab
git config afk.project "mygroup/myproject"
```

### GitHub Project

```bash
# GitHub configuration
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo

# Or use git config
cd /path/to/your/project
git config afk.platform github
git config afk.owner "your-org"
git config afk.repo "your-repo"
```

### Platform Auto-Detection

AFK automatically detects the platform:
1. Checks the `TRACKER_PLATFORM` environment variable
2. Analyzes the git remote URL
3. Checks project config files (.gitlab-ci.yml or .github/workflows/)

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

Let AFK automatically handle runnable Backlog items:

```bash
# Start the implementation → QA → merge loop
afk loop --max-concurrent 3 --poll-interval 60

# The scheduler will automatically:
# - Poll for ready/rework Backlog items every 60 seconds
# - Process up to 3 issues concurrently
# - Verify preconditions (AC, base label, no blockers)
# - Create worktrees and tmux sessions
# - Monitor completion and create MR/PR
```

## Next Steps

- **Architecture Design** → [ARCHITECTURE.md](docs/ARCHITECTURE.md) — Understand the cross-platform abstraction layer
- **Workflow Details** → [WORKFLOWS.md](docs/WORKFLOWS.md) — Deep dive into the three workflow types
- **Skills System** → [SKILLS.md](docs/SKILLS.md) — Learn the design and usage of afk skills

## Troubleshooting

### Command Not Found

```bash
# Re-link
cd /path/to/afk
npm link

# Or run directly
node /path/to/afk/dist/index.js --help
```

### Platform Detection Error

```bash
# Manually specify the platform
export TRACKER_PLATFORM=gitlab  # or github

# Or set in git config
git config afk.platform gitlab
```

### API Permission Error

Make sure your token has sufficient permissions:
- **GitLab**: api, read_api, write_repository
- **GitHub**: repo, workflow

## Need Help?

- Full documentation: `docs/`
- Command help: `afk <command> --help`
- Submit an Issue: https://github.com/easyhaloo/afk/issues
