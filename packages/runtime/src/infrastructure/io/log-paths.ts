import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';

/**
 * The single source of truth for every log destination AFK has.
 *
 * Nothing else may build a log path from `homedir()` by hand — a second
 * hardcoded root is how the watchdog ended up writing into Claude Code's
 * own `~/.claude` tree while the main log lived in `~/.afk/logs`.
 *
 * Layout under the root:
 *
 * ```text
 * ~/.afk/logs/
 * ├── afk-YYYY-MM-DD.log   day-rotated pino log (JSONL)
 * ├── watchdog.log         watchdog trigger lines
 * ├── timeout/             workflow timeout pane snapshots
 * │   └── timeout-<iid>-<timestamp>.log
 * └── qa/                  QA timeout pane snapshots
 *     └── timeout-<backlogId>-<timestamp>.log
 * ```
 *
 * `homedir()` is used rather than the HOME environment variable: a non-login
 * environment (launchd, some CI runners) has no HOME, and a template
 * literal would then produce a relative `undefined/...` path that lands
 * under the current working directory.
 */

/** How long log files are kept before they are pruned. */
export const LOG_RETENTION_DAYS = 7;

/** Root directory of every AFK log. Override with `AFK_LOG_DIR`. */
export function resolveLogDir(): string {
  const override = process.env.AFK_LOG_DIR?.trim();
  return override || join(homedir(), '.afk', 'logs');
}

/** The day-rotated pino log: `<root>/afk-YYYY-MM-DD.log`. */
export function resolveLogPath(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return join(resolveLogDir(), `afk-${now.getFullYear()}-${month}-${day}.log`);
}

/** Workflow timeout snapshots (tmux pane captured at the moment of timeout). */
export function resolveTimeoutSnapshotDir(): string {
  return join(resolveLogDir(), 'timeout');
}

/** QA timeout snapshots (agent output captured at the moment of timeout). */
export function resolveQaTimeoutSnapshotDir(): string {
  return join(resolveLogDir(), 'qa');
}

/** Watchdog trigger lines, appended by the detached watchdog process. */
export function resolveWatchdogLogPath(): string {
  return join(resolveLogDir(), 'watchdog.log');
}

/**
 * Create a log directory, ignoring failures. Logging I/O failing must
 * never take the caller down — the next attempt simply retries.
 */
export function ensureLogDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

/**
 * Prune everything past the retention window: day logs, timeout/qa
 * snapshots and the watchdog log. Called when a new day log is opened,
 * so it runs at most once per day.
 */
export function pruneStaleLogs(now: number = Date.now()): void {
  const cutoff = now - LOG_RETENTION_DAYS * 24 * 3600 * 1000;
  pruneMatching(resolveLogDir(), /^afk-\d{4}-\d{2}-\d{2}\.log$/, cutoff);
  pruneMatching(resolveTimeoutSnapshotDir(), /^timeout-.*\.log$/, cutoff);
  pruneMatching(resolveQaTimeoutSnapshotDir(), /^timeout-.*\.log$/, cutoff);
  pruneFile(resolveWatchdogLogPath(), cutoff);
}

function pruneMatching(dir: string, pattern: RegExp, cutoff: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    pruneFile(join(dir, name), cutoff);
  }
}

function pruneFile(file: string, cutoff: number): void {
  try {
    if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
  } catch {
    /* ignore */
  }
}
