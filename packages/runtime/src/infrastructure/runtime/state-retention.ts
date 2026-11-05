import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * How long AFK keeps the state a finished run leaves behind.
 *
 * The runtime archive (one JSON record per run) and the per-run diagnostic
 * snapshots grew by one entry per run and had no retention at all. On the
 * machine this was written on, ten thousand archive records alone accounted
 * for 41 MB of a 87 MB state directory — the single largest thing AFK owned.
 *
 * Seven days matches the log policy: enough to explain a failure, and the
 * record a reader actually needs (the run itself, the provider, the journals)
 * lives elsewhere.
 */
export interface RetentionPolicy {
  /** Finished-run records under `runtime/tasks/archive`. */
  readonly taskHistoryMs: number;
  /** Per-run diagnostic snapshots under `runtime/tasks/diagnostics`. */
  readonly diagnosticsMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shipped windows. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  taskHistoryMs: 7 * DAY_MS,
  diagnosticsMs: 7 * DAY_MS,
};

/** What one sweep removed. */
export interface RetentionReport {
  readonly archivedRecords: number;
  readonly diagnosticDirectories: number;
}

export interface RetentionOptions {
  /** Runtime task store root. Defaults to `~/.afk/runtime/tasks`. */
  readonly tasksRoot?: string;
  readonly policy?: Partial<RetentionPolicy>;
  readonly now?: () => Date;
}

/**
 * Drop finished-run state past its window.
 *
 * Each store is pruned independently and best effort: a directory that cannot
 * be read, or an entry that cannot be removed, is skipped rather than failing
 * the sweep. A window of zero or less disables that store, which is what a
 * test or an operator who wants to keep everything gets.
 *
 * Only finished runs are affected: an active run lives under `active/`, and
 * its diagnostics directory is written by that run, so it is inside the
 * window by construction.
 */
export async function pruneRuntimeState(options: RetentionOptions = {}): Promise<RetentionReport> {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...options.policy };
  const now = options.now?.() ?? new Date();
  const tasksRoot = options.tasksRoot ?? join(homedir(), '.afk', 'runtime', 'tasks');
  const archivedRecords = await pruneFiles(join(tasksRoot, 'archive'), now, policy.taskHistoryMs);
  const diagnosticDirectories = await pruneDirectories(join(tasksRoot, 'diagnostics'), now, policy.diagnosticsMs);
  return { archivedRecords, diagnosticDirectories };
}

async function pruneFiles(directory: string, now: Date, retentionMs: number): Promise<number> {
  const cutoff = cutoffFor(now, retentionMs);
  if (cutoff === undefined) return 0;
  let removed = 0;
  for (const entry of await readEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (await removeAged(join(directory, entry.name), cutoff, false)) removed += 1;
  }
  return removed;
}

async function pruneDirectories(directory: string, now: Date, retentionMs: number): Promise<number> {
  const cutoff = cutoffFor(now, retentionMs);
  if (cutoff === undefined) return 0;
  let removed = 0;
  for (const entry of await readEntries(directory)) {
    if (!entry.isDirectory()) continue;
    if (await removeAged(join(directory, entry.name), cutoff, true)) removed += 1;
  }
  return removed;
}

/** Remove one entry when it is older than the cutoff; say whether it went. */
async function removeAged(path: string, cutoff: number, recursive: boolean): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => undefined);
  if (!stat || stat.mtimeMs >= cutoff) return false;
  return fs.rm(path, { recursive, force: true }).then(() => true).catch(() => false);
}

/** The instant before which state may be dropped, or undefined when retention is off. */
function cutoffFor(now: Date, retentionMs: number): number | undefined {
  if (!(retentionMs > 0)) return undefined;
  return now.getTime() - retentionMs;
}

async function readEntries(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
