#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$PROJECT_DIR/.dev"
PID_FILE="$STATE_DIR/afk-control-dev.pid"
LOG_FILE="$STATE_DIR/afk-control-dev.log"
PORT="${AFK_CONTROL_PORT:-5174}"
PACKAGED_PROCESS_PATTERN='AFK Control.app/Contents/MacOS/AFK Control'

mkdir -p "$STATE_DIR"

# Kill a process and all of its descendants (depth-first).
kill_tree() {
  local pid="$1" signal="${2:-TERM}" kid
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  for kid in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$kid" "$signal"
  done
  kill -"$signal" "$pid" 2>/dev/null || true
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

port_is_listening() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

is_dev_command() {
  local cmd="$1"
  case "$cmd" in
    *"dev:raw"*|*"concurrently"*|*"dev:main"*|*"vite/bin/vite.js --port $PORT"*|*"vite --port $PORT"*|*"wait-on tcp:$PORT"*|*"tsc -p tsconfig.electron.json --watch"*|*"electron/cli.js ."*|*"pnpm exec electron ."*|*"Electron.app/Contents/MacOS/Electron ."*)
      return 0
      ;;
  esac
  return 1
}

is_dev_process() {
  local pid="$1" cwd cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  is_dev_command "$cmd" || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [[ "$cwd" == "$PROJECT_DIR" || "$cwd" == "$PROJECT_DIR/"* ]]
}

list_dev_processes() {
  ps -axo pid=,command= | awk '{ pid = $1; $1 = ""; sub(/^ /, ""); print pid "\t" $0 }' | while IFS=$'\t' read -r pid cmd; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    is_dev_command "$cmd" || continue
    is_dev_process "$pid" && printf '%s\n' "$pid"
  done
}

stop_dev_processes() {
  local signal="${1:-TERM}" pid
  for pid in $(list_dev_processes); do
    [[ "$pid" == "$$" ]] && continue
    echo "Stopping existing AFK Control dev process (pid $pid)..."
    kill_tree "$pid" "$signal"
  done
}

wait_for_shutdown() {
  local remaining
  for _ in {1..40}; do
    remaining="$(list_dev_processes)"
    if [[ -z "$remaining" ]] && ! port_is_listening; then
      return 0
    fi
    sleep 0.25
  done

  stop_dev_processes KILL
  for _ in {1..20}; do
    remaining="$(list_dev_processes)"
    [[ -z "$remaining" ]] && ! port_is_listening && return 0
    sleep 0.25
  done
  return 1
}

# --- 1. Tear down any previous dev stack -----------------------------------
pkill -f "$PACKAGED_PROCESS_PATTERN" >/dev/null 2>&1 || true

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Stopping previous AFK Control dev service (pid $pid)..."
    if is_dev_process "$pid"; then
      kill_tree "$pid"
    fi
  fi
  rm -f "$PID_FILE"
fi

stop_dev_processes

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

fi

# --- 2. Wait for the previous stack to be fully released -------------------
if ! wait_for_shutdown; then
  echo "Previous AFK Control dev service did not stop cleanly; refusing to start a duplicate." >&2
  exit 1
fi

# --- 3. Start fresh --------------------------------------------------------
cd "$PROJECT_DIR"
service_pid="$(node - "$LOG_FILE" "$PROJECT_DIR" <<'NODE'
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const [logFile, cwd] = process.argv.slice(2);
const logFd = fs.openSync(logFile, "w");
const child = spawn("pnpm", ["run", "dev:raw"], {
  cwd,
  detached: true,
  stdio: ["ignore", logFd, logFd],
});

if (!child.pid) process.exit(1);
child.unref();
process.stdout.write(String(child.pid));
NODE
)"
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

kill_tree "$service_pid" KILL
rm -f "$PID_FILE"
echo "Timed out waiting for AFK Control dev service. See $LOG_FILE." >&2
exit 1
