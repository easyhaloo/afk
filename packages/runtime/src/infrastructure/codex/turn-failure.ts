/**
 * Watching a Codex turn from the outside.
 *
 * Codex reports a turn that died — a stream the upstream gateway cut, a
 * request it could not send — by writing a `task_complete` event that
 * carries an error. The terminal stays open, waiting for the next prompt, so
 * nothing about the process says the turn is over: AFK would keep waiting for
 * a completion signal that will never come.
 *
 * The rollout file is where Codex says this. AFK already reads it for token
 * accounting; reading it for the verdict is the same file, read sooner.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Why a Codex turn ended without producing anything. */
export interface CodexTurnFailure {
  /** Codex's own words. */
  message: string;
  /** Codex's error classification, when it gave one. */
  code?: string;
}

/**
 * Find the rollout file Codex wrote for a directory.
 *
 * A rollout records the working directory it ran in, so the directory is the
 * key that ties a transcript to the work AFK started. The newest file wins:
 * Codex appends to one file per session, and a worktree can be visited more
 * than once.
 */
export async function findCodexRolloutForDirectory(
  workingDirectory: string,
  rootDir?: string,
): Promise<string | undefined> {
  const sessionsRoot = join(rootDir ?? homedir(), '.codex', 'sessions');
  let yearDirs: string[];
  try {
    yearDirs = (await readdir(sessionsRoot)).filter(name => !name.startsWith('.'));
  } catch {
    return undefined;
  }

  let newest: { path: string; modifiedAt: number } | undefined;
  for (const yearDir of yearDirs) {
    const monthRoot = join(sessionsRoot, yearDir);
    let monthDirs: string[];
    try {
      monthDirs = (await readdir(monthRoot)).filter(name => !name.startsWith('.'));
    } catch {
      continue;
    }
    for (const monthDir of monthDirs) {
      const dayRoot = join(monthRoot, monthDir);
      let dayDirs: string[];
      try {
        dayDirs = (await readdir(dayRoot)).filter(name => !name.startsWith('.'));
      } catch {
        continue;
      }
      for (const dayDir of dayDirs) {
        const dayPath = join(dayRoot, dayDir);
        let files: string[];
        try {
          files = (await readdir(dayPath)).filter(name => name.startsWith('rollout-') && name.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const file of files) {
          const path = join(dayPath, file);
          if (!(await rolloutBelongsToDirectory(path, workingDirectory))) continue;
          const info = await stat(path).catch(() => undefined);
          if (!info) continue;
          if (!newest || info.mtimeMs > newest.modifiedAt) newest = { path, modifiedAt: info.mtimeMs };
        }
      }
    }
  }
  return newest?.path;
}

/** Whether a rollout was recorded in a given working directory. */
async function rolloutBelongsToDirectory(path: string, workingDirectory: string): Promise<boolean> {
  const head = await readHead(path, 64 * 1024);
  if (!head) return false;
  const firstLine = head.split('\n', 1)[0];
  if (!firstLine) return false;
  try {
    const parsed = JSON.parse(firstLine) as { type?: string; payload?: { cwd?: string } };
    if (parsed.type !== 'session_meta') return false;
    return parsed.payload?.cwd === workingDirectory;
  } catch {
    return false;
  }
}

/**
 * Read the failure of the last Codex turn, if it failed.
 *
 * A turn that ended with an error is a `task_complete` event whose `error`
 * is set. A turn that succeeded has no error, and a turn that is still
 * running has no `task_complete` at all.
 */
export async function readCodexTurnFailure(path: string): Promise<CodexTurnFailure | undefined> {
  const tail = await readTail(path, 256 * 1024);
  if (!tail) return undefined;
  const lines = tail.split('\n');
  // The first line of a tail read may be cut in half; it cannot be a whole
  // event, so it is not a verdict.
  for (let index = lines.length - 1; index >= 1; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    let event: { type?: string; payload?: { type?: string; error?: { message?: string; codex_error_info?: string } } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== 'event_msg') continue;
    if (event.payload?.type !== 'task_complete') continue;
    const error = event.payload.error;
    if (!error) return undefined; // the turn completed
    return {
      message: error.message?.trim() || 'the Codex turn ended with an error',
      ...(error.codex_error_info ? { code: error.codex_error_info } : {}),
    };
  }
  return undefined;
}

/**
 * Watch one Codex session for a turn that died.
 *
 * The rollout grows while Codex works, so it is re-read only when it changed.
 * The watcher remembers which file it is looking at, because a worktree can
 * be visited more than once and each visit is a new session.
 */
export class CodexTurnWatcher {
  private path: string | undefined;
  private lastSize = -1;
  private lastFailure: CodexTurnFailure | undefined;

  /** The failure of the last turn, if it failed. */
  get failure(): CodexTurnFailure | undefined {
    return this.lastFailure;
  }

  /**
   * Look for a failed turn.
   *
   * Returns the failure when the last Codex turn ended in one, undefined
   * otherwise — including when the verdict is not known yet.
   */
  async check(workingDirectory: string, rootDir?: string): Promise<CodexTurnFailure | undefined> {
    const path = await this.resolvePath(workingDirectory, rootDir);
    if (!path) return this.lastFailure;

    const size = (await stat(path).catch(() => undefined))?.size ?? 0;
    if (path === this.path && size === this.lastSize) return this.lastFailure;

    this.path = path;
    this.lastSize = size;
    this.lastFailure = await readCodexTurnFailure(path);
    return this.lastFailure;
  }

  private async resolvePath(workingDirectory: string, rootDir?: string): Promise<string | undefined> {
    if (this.path) {
      const stillThere = await stat(this.path).catch(() => undefined);
      if (stillThere) return this.path;
      this.path = undefined;
      this.lastSize = -1;
    }
    this.path = await findCodexRolloutForDirectory(workingDirectory, rootDir);
    return this.path;
  }
}

async function readTail(path: string, bytes: number): Promise<string | undefined> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    const length = Math.min(bytes, info.size);
    const position = info.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readHead(path: string, bytes: number): Promise<string | undefined> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
