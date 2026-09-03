#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$PROJECT_DIR/.dev"
PID_FILE="$STATE_DIR/afk-control-dev.pid"
LOG_FILE="$STATE_DIR/afk-control-dev.log"
PORT="${AFK_CONTROL_PORT:-5174}"
PACKAGED_PROCESS_PATTERN='AFK Control.app/Contents/MacOS/AFK Control'

mkdir -p "$STATE_DIR"

if pgrep -f "$PACKAGED_PROCESS_PATTERN" >/dev/null 2>&1; then
  echo "AFK Control desktop service is already running; reusing the existing instance."
  exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl --silent --show-error --fail --max-time 2 "http://localhost:$PORT/" >/dev/null 2>&1; then
    echo "AFK Control dev service is already serving http://localhost:$PORT/."
    exit 0
  fi
  echo "Port $PORT is already occupied by another service; refusing to start a duplicate." >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "AFK Control dev service is already running (pid $pid, http://localhost:$PORT)."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$PROJECT_DIR"
nohup bash -c 'exec pnpm dev:raw' >"$LOG_FILE" 2>&1 < /dev/null &
service_pid=$!
printf '%s\n' "$service_pid" >"$PID_FILE"

cleanup_stale_pid() {
  if ! kill -0 "$service_pid" 2>/dev/null; then rm -f "$PID_FILE"; fi
}
trap cleanup_stale_pid EXIT

for _ in {1..60}; do
  if ! kill -0 "$service_pid" 2>/dev/null; then
    echo "AFK Control dev service exited during startup. See $LOG_FILE." >&2
    exit 1
  fi
  if curl --silent --show-error --fail --max-time 2 "http://localhost:$PORT/" >/dev/null 2>&1; then
    echo "Started AFK Control dev service (pid $service_pid): http://localhost:$PORT/"
    exit 0
  fi
  sleep 0.25
done

echo "Timed out waiting for AFK Control dev service. See $LOG_FILE." >&2
exit 1
