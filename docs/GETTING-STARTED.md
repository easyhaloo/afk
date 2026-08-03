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

### Issue Operations

```bash
# View issue details
afk issue get 123

# List issues
afk issue list --label "stage::ready-for-implement"

# Create an issue
afk issue create "Add user login" --label "feature"

# Add a comment
afk issue comment 123 "Working on this"
```

### Cross-Project Operations

The `--project <repo>` flag lets `afk issue` commands target projects outside of cwd. For the same repo you can omit the prefix; for cross-repo use the `<project>:<iid>` syntax:

```bash
# Operate on repo A's issue from within repo B's directory
afk issue get 42 --project group/repo-a

# Cross-project link (link to A's #42 from B)
afk issue link 100 group/repo-a:42 --project group/repo-b

# One-click cross-project workflow (ProjectResolverModule will chdir to target repo first)
afk issue run 42 --project group/repo-a
```

No need to configure `GITLAB_PROJECT_ID` or other environment variables; project resolution follows the priority: `git remote > --project > auto-detection`.

### MR/PR Operations

```bash
# Create an MR/PR
afk mr create "feat: add login" --source feat/login --target main

# View an MR/PR
afk mr get 456

# Merge an MR/PR
afk mr merge 456 --delete-source-branch

# Approve an MR/PR
afk mr approve 456
```

### Full Workflow Example

End-to-end flow from issue to merge:

```bash
# 1. Find issues ready for implementation
afk issue list --label "stage::ready-for-implement"

# 2. Start a workflow (creates worktree + tmux session)
afk workflow run --iid 123 --base-branch main

# 3. In the tmux session, Claude will automatically run /afk-implement
# Monitor progress (optional)
tmux attach -t afk-issue-123

# 4. Workflow auto-creates MR/PR and cleans up worktree on completion
```

## Automated Scheduling

Let AFK automatically handle all ready issues:

```bash
# Start the scheduler
afk scheduler start --max-concurrent 3 --poll-interval 60

# The scheduler will automatically:
# - Poll for new ready issues every 60 seconds
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
