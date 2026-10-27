# Getting Started

Get up and running with AFK CLI in 5 minutes.

## Installation

Install Node.js 22.16 or later and ensure `node` and `tar` are on `PATH`.
Precompiled releases support macOS and glibc Linux on x64 and arm64.
The installer downloads a release with production dependencies, verifies its
SHA-256 and startup, then activates it. It never installs dependencies, builds
source, or runs a test suite; pnpm, git, and a compiler are unnecessary for
installation. Git and other tools used by individual commands are still needed
when executing those commands.

After the first `cli-v*` release has been published:

```bash
curl -fsSL https://github.com/easyhaloo/afk/releases/latest/download/install.sh -o /tmp/afk-install.sh
bash /tmp/afk-install.sh
```

An existing checkout can also run `./install.sh`; it downloads the same release
without building the checkout. Options:

```bash
bash /tmp/afk-install.sh --version 0.1.0 --skip-completion
bash /tmp/afk-install.sh --prefix "$HOME/bin"
bash /tmp/afk-install.sh --archive ./afk-darwin-arm64.tar.gz --checksum ./afk-darwin-arm64.tar.gz.sha256
```

The executable at `~/.local/bin/afk` points into
`~/.afk/cli/versions/<version>-<platform>-<arch>-<sha256>/`. Reinstalling upgrades
that link atomically; download, checksum, or startup failures preserve the old
version. Previous versions remain on disk. Replacing an unmanaged executable
requires `--force`. Directories are never replaced.
The default path needs no elevated permissions. `--system` selects
`/usr/local/bin` and requires write access already granted to your user.
Shell completion is optional and can be disabled with `--skip-completion`.
Add the executable directory to your shell's `PATH` if the installer requests it.

AFK configuration and system data remain in `~/.afk/`; execution workspaces
remain in `~/.loop-workspace/`.

Verify the installation:
```bash
afk --version
afk --help
```

### Build and publish a CLI release

Maintainers build on each target platform with pnpm (CI pins 12.5.1);
users install the resulting archive:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm rebuild esbuild
pnpm release:cli
```

Local pnpm 12.5.1 is also supported. The release builder preserves the source
workspace's dependency metadata around deploy.

`release/cli/` contains `install.sh`, `afk-<platform>-<arch>.tar.gz`, and its
`.sha256` file. The packaging script builds the CLI and its workspace dependencies,
uses `pnpm deploy --legacy --prod --ignore-scripts --config.hoist=false --config.force=false`
to include production dependencies, and tests an offline installation outside the source tree with
build tools blocked. It checks every command registry entry with `--help`.

Set `apps/cli/package.json` and the CLI's reported version to the same version,
then merge that version bump into `main`. The
[CLI release workflow](../.github/workflows/release-cli.yml) detects a new CLI
version, creates the matching tag such as `cli-v0.1.0`, builds and verifies all
four targets, and publishes the assets to GitHub Releases. An existing version
and Release are skipped, so normal commits do not republish the same package.
Pushing a matching `cli-v` tag manually remains supported. CLI tags use `cli-v`;
plugin versions are separate.
The workflow marks CLI releases as `latest`; keep plugin releases from changing
that pointer. Use `--version` for a pinned install. Windows and musl/Alpine packages
are not provided.

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
# Add the installed executable to PATH (use your custom prefix if applicable)
export PATH="$HOME/.local/bin:$PATH"
afk --version
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
