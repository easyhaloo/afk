FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    TERM=xterm-256color \
    SHELL=/bin/bash \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_update_notifier=false

# Base image: language runtimes, source control and common agent tooling.
# The official Node image already provides the non-root `node` user (UID/GID
# 1000), so the sandbox can use the provider's default 1000:1000 identity.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      bash \
      ca-certificates \
      curl \
      git \
      git-lfs \
      jq \
      ripgrep \
      tmux \
      golang \
      rustc \
      cargo \
      python3 \
      build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack install --global pnpm@10.33.0 \
    && mkdir -p /workspace /afk/session /afk/result \
    && chown -R node:node /workspace /afk \
    && git config --system init.defaultBranch main

USER node
WORKDIR /workspace

CMD ["sleep", "infinity"]
