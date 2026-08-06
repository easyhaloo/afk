# AFK sandbox image

Build the predefined base image, then the Claude Code extension image:

```sh
docker build -f docker/afk-sandbox-base.Dockerfile -t afk-sandbox-base:node22 .
docker build -f docker/afk-sandbox-claude.Dockerfile -t afk-sandbox-claude:node22 .
```

The base image includes:

- Node.js 22, npm, Corepack and pnpm
- TypeScript through the Node.js toolchain, plus Go and Rust
- Git and Git LFS
- tmux, ripgrep, jq and curl
- Python 3 and native build tooling for common dependencies

The Claude extension image adds:

- Claude Code CLI

Both images run as the non-root `node` user (UID/GID 1000). Pass credentials at
runtime; do not put API keys in these Dockerfiles or in a committed environment
file.

Run an AFK backlog in the Docker sandbox with the extension image:

```sh
ANTHROPIC_API_KEY=... \
AFK_SANDBOX_IMAGE=afk-sandbox-claude:node22 \
afk run --backlog-id <id> --sandbox docker --execution-mode batch
```

The Docker sandbox intentionally supports `batch` execution only. Use the
local sandbox for tmux-backed interactive or HITL sessions.
