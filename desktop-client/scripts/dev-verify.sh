#!/usr/bin/env bash
# Local verification launcher.
#
# `pnpm dev` cannot be used here: dev:raw hardcodes --port 5174 AND
# ELECTRON_RENDERER_URL=http://localhost:5174, and another Claude session is
# already running Vite on 5174 from the main checkout. Launching as-is would
# show that session's build, not this worktree's.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${AFK_VERIFY_PORT:-5205}"
echo "==> building electron main (watch)"
pnpm dev:main &

echo "==> vite on :$PORT"
npx vite --port "$PORT" &

echo "==> waiting for vite + main build"
npx wait-on "tcp:$PORT" file:dist-electron/electron/main.js

echo "==> launching electron against :$PORT"
ELECTRON_RENDERER_URL="http://localhost:$PORT" npx electron .