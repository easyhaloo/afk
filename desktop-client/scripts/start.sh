#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$PROJECT_DIR/.dev"
PID_FILE="$STATE_DIR/afk-control-dev.pid"
LOG_FILE="$STATE_DIR/afk-control-dev.log"
PORT="${AFK_CONTROL_PORT:-5174}"
PACKAGED_PROCESS_PATTERN='AFK Control.app/Contents/MacOS/AFK Control'

mkdir -p "$STATE_DIR"

# Kill a process and all of its descendants (depth-first, TERM).
kill_tree() {
  local pid="$1" kid
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  for kid in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$kid"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

# True when the process belongs to this project: its cwd or command line
# references PROJECT_DIR. Guards against killing an unrelated service.
is_project_process() {
  local pid="$1" cwd cmd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [[ -n "$cwd" && "$cwd" == "$PROJECT_DIR"* ]] && return 0
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [[ "$cmd" == *"$PROJECT_DIR"* ]]
}

# --- 1. Tear down any previous dev stack -----------------------------------
pkill -f "$PACKAGED_PROCESS_PATTERN" >/dev/null 2>&1 || true

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Stopping previous AFK Control dev service (pid $pid)..."
    kill_tree "$pid"
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true); do
    kill -0 "$pid" 2>/dev/null || continue
    if is_project_process "$pid"; then
      echo "Stopping stale listener on port $PORT (pid $pid)..."
      kill_tree "$pid"
    else
      echo "Port $PORT is occupied by another service (pid $pid); refusing to kill it." >&2
      exit 1
    fi
  done

  # --- 2. Wait for the port to be released before replacing it -------------
  for _ in {1..40}; do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.25
  done
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT still held after shutdown; refusing to start a duplicate." >&2
    exit 1
  fi
fi

# --- 3. Start fresh --------------------------------------------------------
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
