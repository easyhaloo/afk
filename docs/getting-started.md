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
pnpm --dir apps/cli link --global
```

Verify the installation:
```bash
afk --version
afk --help
```

## Configuration

### Provider credentials

AFK reads provider credentials from the environment or from the provider CLI:

```bash
# GitHub: GITHUB_TOKEN / GH_TOKEN, or `gh auth login`
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx

# GitLab: GITLAB_TOKEN plus the optional GITLAB_URL, or `glab auth login`
export GITLAB_TOKEN=glpat_xxxxxxxxxxxxx
export GITLAB_URL=https://gitlab.company.com   # Optional, defaults to gitlab.com
```

### Tracker target

Every provider-backed command needs to know which provider project to talk
to. AFK resolves that target in this order:

1. the `--project` / `--platform` command-line flags
2. the local tracker index, by issue id — AFK wrote that association when it
   last worked with the issue
3. the local tracker index, by working directory
4. the `AFK_TRACKER_PROJECT` / `AFK_TRACKER_PLATFORM` environment variables
5. the `origin` remote of the current git repository

The git remote is optional, so read-only commands such as `afk backlog show`
work from any directory once the target is known:

```bash
export AFK_TRACKER_PROJECT=my-org/my-repo
export AFK_TRACKER_PLATFORM=github   # Optional; inferred from the project key
afk backlog show --id 123
```

When the platform is still unknown, a numeric project key (`202`) or a key
with three or more path segments (`group/sub/project`) resolves to GitLab,
and an `owner/repo` key resolves to GitHub unless only GitLab credentials
are configured.

### Local tracker index

AFK keeps a local index of the provider projects it has worked with, in
`~/.afk/tracker-projects.json`, shared across workspaces. Every backlog
listing, issue lookup, inventory and execution writes what it saw: the
provider project, the repository it was reached from, and the issues it
touched.

That index is what makes a bare issue id enough, in any directory:

```bash
afk backlog show --id 229
```

With several repositories AFK learns the association on its own: standing in
a repository selects its project, and an issue id selects the project the
issue belongs to. No per-repository configuration is required. The index is a
local cache — provider state always comes from the provider.

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

Outside a git repository, name the project explicitly instead:

```bash
afk backlog show --id 42 --project my-org/my-repo --platform github
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

- **Architecture Design** → [overview.md](docs/architecture/overview.md) — Understand the cross-platform abstraction layer
- **Workflow Details** → [workflows.md](docs/guides/workflows.md) — Deep dive into the three workflow types
- **Skills System** → [skills.md](docs/guides/skills.md) — Learn the design and usage of afk skills

## Troubleshooting

### Command Not Found

```bash
# Re-link
cd /path/to/afk
npm link

# Or run directly
node /path/to/afk/apps/cli/dist/index.js --help
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
