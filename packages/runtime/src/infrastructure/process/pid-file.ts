import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AFK_HOME = path.join(os.homedir(), '.afk');

/**
 * Where the single-loop layout kept its files before runs became directories.
 *
 * They are read for one release so an upgrade does not lose sight of a loop
 * that is already running, and never written again.
 */
export const LEGACY_LOOP_PID_FILE = path.join(AFK_HOME, 'loop.pid');
export const LEGACY_LOOP_STATUS_FILE = path.join(AFK_HOME, 'loop-status.json');

/** The tag of the only loop a machine runs when the operator names none. */
export const DEFAULT_LOOP_RUN_TAG = 'default';

/**
 * A directory name for one loop run.
 *
 * The tag only has to be stable and unique, not readable, but it is also made
 * from a work item id and typed by an operator, so it is restricted to
 * characters that survive a shell and a path segment. Rejecting `.` and `..`
 * is what keeps a tag inside the runs directory.
 */
/** Longest tag a run directory may have. */
export const MAX_LOOP_RUN_TAG_LENGTH = 64;

export function sanitizeLoopRunTag(raw: string): string {
  const tag = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_LOOP_RUN_TAG_LENGTH);
  if (!tag || tag === '.' || tag === '..') throw new Error(`invalid loop run tag: ${JSON.stringify(raw)}`);
  return tag;
}

/**
 * The tag for a loop bound to one work item.
 *
 * `gitlab:host/group/project#3` files under `project-3-<hash>`, which keeps
 * the directory meaningful without repeating the instance host in every path.
 *
 * The hash is what makes the tag unique: the readable part alone would put
 * `git.corp/group/project#3` and `gitlab.com/group/project#3` in the same
 * directory, and the second loop would then be told it is already running.
 * The suffix is reserved before the slug is shortened, so a long project name
 * loses characters from its readable part, never from its identity.
 */
export function loopRunTagForWorkItem(workItemId?: string): string {
  if (!workItemId) return DEFAULT_LOOP_RUN_TAG;
  const parts = workItemId.split(/[#/:]+/).filter(part => part.length > 0);
  const suffix = createHash('sha256').update(workItemId).digest('hex').slice(0, 6);
  try {
    const slug = sanitizeLoopRunTag(parts.slice(-2).join('-'));
    const head = slug.slice(0, MAX_LOOP_RUN_TAG_LENGTH - suffix.length - 1).replace(/-+$/, '');
    return head ? `${head}-${suffix}` : suffix;
  } catch {
    return DEFAULT_LOOP_RUN_TAG;
  }
}

/**
 * Where the per-work-item loop runs live.
 *
 * A deployment that runs one loop per work item gives each one its own pid
 * and status file. They share a directory, so the directory is the thing an
 * operator can look at to see every loop at once. The directory may move as a
 * whole — tests sandbox it — but a single run's file paths are never
 * configured independently: an arbitrary status path is how state ends up
 * outside `~/.afk`, which is exactly what this module exists to prevent.
 */
export function loopRunsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AFK_LOOP_RUNS_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(AFK_HOME, 'loop-runs');
}

/** The directory holding one loop run: its pid file and status snapshot. */
export function loopRunDirectory(tag: string = DEFAULT_LOOP_RUN_TAG, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(loopRunsDirectory(env), tag);
}

/** Where a loop run records its process id. */
export function loopPidFilePath(tag: string = DEFAULT_LOOP_RUN_TAG, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(loopRunDirectory(tag, env), 'loop.pid');
}

/** Where a loop run writes its status snapshot. */
export function loopStatusFilePath(tag: string = DEFAULT_LOOP_RUN_TAG, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(loopRunDirectory(tag, env), 'status.json');
}

/** Every loop run recorded on disk, in name order. */
export function loopRunTags(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return fs.readdirSync(loopRunsDirectory(env), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** The tags whose pid file names a live process. */
export function liveLoopRunTags(env: NodeJS.ProcessEnv = process.env): string[] {
  return loopRunTags(env).filter(tag => {
    const pid = readPid(tag, env);
    return pid !== null && isProcessAlive(pid);
  });
}

/**
 * The `AFK_LOOP_*` overrides that used to redirect the pid and status files.
 *
 * They are ignored now: state belongs under `~/.afk/loop-runs/`. Naming them
 * lets a command say so instead of silently writing somewhere else.
 */
export function legacyLoopPathOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['AFK_LOOP_PID_FILE', 'AFK_LOOP_STATUS_FILE'].filter(name => Boolean(env[name]?.trim()));
}

export function ensurePidDirectory(tag: string = DEFAULT_LOOP_RUN_TAG, env: NodeJS.ProcessEnv = process.env): void {
  fs.mkdirSync(path.dirname(loopPidFilePath(tag, env)), { recursive: true });
}

export function readPid(tag: string = DEFAULT_LOOP_RUN_TAG, env: NodeJS.ProcessEnv = process.env): number | null {
  return readPidFileAt(loopPidFilePath(tag, env));
}

/**
 * Forget a run's pid file, and the retired single-loop file with it.
 *
 * The legacy file is only removed when its process is gone: a loop started by
 * an older CLI is still writing it, and deleting it would leave that loop
 * running with nothing pointing at it — alive but unstoppable.
 */
export function removePidFile(tag: string = DEFAULT_LOOP_RUN_TAG, env: NodeJS.ProcessEnv = process.env): void {
  const files = [loopPidFilePath(tag, env)];
  if (tag === DEFAULT_LOOP_RUN_TAG && !isLegacyLoopAlive()) files.push(LEGACY_LOOP_PID_FILE);
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // A missing pid file is already the desired state.
    }
  }
}

/** Whether a loop started by an older CLI is still running under the legacy file. */
export function isLegacyLoopAlive(): boolean {
  const pid = readPidFileAt(LEGACY_LOOP_PID_FILE);
  return pid !== null && isProcessAlive(pid);
}

/** The pid recorded in one pid file, or null when it is missing or unreadable. */
export function readPidFileAt(file: string): number | null {
  try {
    const value = Number(fs.readFileSync(file, 'utf-8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not owned by this user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
