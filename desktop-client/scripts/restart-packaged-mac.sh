#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$PROJECT_DIR/release/mac-arm64/AFK Control.app"
PROCESS_PATTERN='AFK Control.app/Contents/MacOS/AFK Control'

stop_existing_instances() {
  local pids
  pids="$(pgrep -f "$PROCESS_PATTERN" || true)"

  if [[ -z "$pids" ]]; then
    echo "No existing AFK Control instance found."
    return
  fi

  echo "Stopping existing AFK Control instance(s): $pids"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done <<< "$pids"

  for _ in {1..20}; do
    pgrep -f "$PROCESS_PATTERN" >/dev/null || return 0
    sleep 0.15
  done

  pids="$(pgrep -f "$PROCESS_PATTERN" || true)"
  if [[ -n "$pids" ]]; then
    echo "Force-stopping remaining AFK Control instance(s): $pids"
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
    done <<< "$pids"
  fi
}

cd "$PROJECT_DIR"
stop_existing_instances

pnpm package:mac

test -x "$APP_PATH/Contents/MacOS/AFK Control"
open -n "$APP_PATH"

for _ in {1..20}; do
  pgrep -f "$PROCESS_PATTERN" >/dev/null && break
  sleep 0.15
done

instance_count="$(pgrep -f "$PROCESS_PATTERN" | wc -l | tr -d ' ')"
if [[ "$instance_count" != "1" ]]; then
  echo "Expected exactly one AFK Control main process; found $instance_count." >&2
  exit 1
fi

echo "Started the latest AFK Control build with a single instance."
