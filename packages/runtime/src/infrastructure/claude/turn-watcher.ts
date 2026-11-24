/**
 * Watching a Claude Code turn from the outside.
 *
 * Claude Code records the end of a turn in its own transcript: a
 * `system`/`turn_duration` entry is written when the model hands the turn
 * back to the user. Nothing about the process says so — the TUI stays open,
 * waiting for the next prompt — so AFK would keep waiting for a completion
 * signal that will never come, until the idle timeout fires.
 *
 * The transcript is where Claude Code says this. AFK already reads it for
 * telemetry; reading it for the verdict is the same file, read sooner.
 *
 * A turn that ends is not the end of the run: the agent may still be asked
 * for the report it forgot to write. That is the caller's business — this
 * module only reports what the transcript says.
 */

import { readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTurnVerdict } from '../../domain/agents/types.js';
import { claudeProjectSlug } from '../../shared/agent-transcript-path.js';

/** How much of the transcript tail is read. */
const TAIL_BYTES = 512 * 1024;

/** How much of the agent's last words is kept as the reason. */
const LAST_WORDS_LIMIT = 300;

/**
 * Find the transcript Claude Code wrote for a directory.
 *
 * Claude Code keeps one directory per project, named after the working
 * directory, and one file per session inside it. A worktree can be visited
 * more than once, so the newest file wins.
 *
 * `sinceMs` matters: a worktree that was visited before still has its older
 * transcript on disk, and an attempt must not be judged by the attempt before
 * it. Only a transcript written at or after that moment belongs to this
 * attempt.
 */
export async function findClaudeTranscriptForDirectory(
  workingDirectory: string,
  options: { sinceMs?: number; rootDir?: string } = {},
): Promise<string | undefined> {
  const { sinceMs, rootDir } = options;
  let base = workingDirectory;
  try {
    base = realpathSync(workingDirectory);
  } catch {
    /* the path may not exist yet — the plain form is enough */
  }
  const directory = join(rootDir ?? homedir(), '.claude', 'projects', claudeProjectSlug(base));
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return undefined;
  }

  let newest: { path: string; modifiedAt: number } | undefined;
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const path = join(directory, file);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (sinceMs !== undefined && info.mtimeMs < sinceMs) continue;
    if (!newest || info.mtimeMs > newest.modifiedAt) newest = { path, modifiedAt: info.mtimeMs };
  }
  return newest?.path;
}

/**
 * Read what a Claude Code transcript says about the turn.
 *
 * The turn ended when Claude Code wrote a `turn_duration` entry and nothing
 * came after it: an `api-request` after that entry means the agent started
 * another turn, so the first one is over but the run is not.
 *
 * Returns undefined while the turn is still running.
 */
export async function readClaudeTurnVerdict(path: string): Promise<AgentTurnVerdict | undefined> {
  const tail = await readTail(path, TAIL_BYTES);
  if (!tail) return undefined;
  const lines = tail.split('\n');
  let requestSeen = false;
  let endedAt = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const entry = parseEntry(line);
    if (!entry) continue;
    if (entry.type === 'api-request') {
      requestSeen = true;
      continue;
    }
    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      endedAt = index;
      break;
    }
  }
  // Another turn started after this one ended: the run is not over.
  if (endedAt < 0 || requestSeen) return undefined;
  const lastWords = lastAssistantText(lines, endedAt);
  return {
    message: lastWords
      ? `the agent finished its turn without writing the completion signal: ${lastWords}`
      : 'the agent finished its turn without writing the completion signal',
    ended: true,
  };
}

/**
 * The agent's last words before the turn ended.
 *
 * They are the reason a turn ended: an API error, a refusal, a question the
 * agent could not answer. The transcript keeps the text of the final answer
 * in the assistant message.
 */
function lastAssistantText(lines: string[], before: number): string | undefined {
  for (let index = before; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const entry = parseEntry(line);
    if (!entry || entry.type !== 'assistant') continue;
    const text = assistantText(entry);
    if (text) return text;
  }
  return undefined;
}

/**
 * Watch one Claude Code session for a turn that ended.
 *
 * The transcript grows while Claude Code works, so it is re-read only when it
 * changed. The watcher remembers which file it is looking at, because a
 * worktree can be visited more than once and each visit is a new session.
 */
export class ClaudeTurnWatcher {
  private path: string | undefined;
  private lastSize = -1;
  private lastVerdict: AgentTurnVerdict | undefined;

  /** What the transcript last said about the turn. */
  get verdict(): AgentTurnVerdict | undefined {
    return this.lastVerdict;
  }

  /**
   * Look for a turn that ended.
   *
   * Returns the verdict when the turn is over, undefined otherwise —
   * including when the verdict is not known yet.
   */
  async check(
    workingDirectory: string,
    sinceMs?: number,
    rootDir?: string,
  ): Promise<AgentTurnVerdict | undefined> {
    const path = await this.resolvePath(workingDirectory, sinceMs, rootDir);
    if (!path) return this.lastVerdict;

    const size = (await stat(path).catch(() => undefined))?.size ?? 0;
    if (path === this.path && size === this.lastSize) return this.lastVerdict;

    this.path = path;
    this.lastSize = size;
    this.lastVerdict = await readClaudeTurnVerdict(path);
    return this.lastVerdict;
  }

  private async resolvePath(
    workingDirectory: string,
    sinceMs?: number,
    rootDir?: string,
  ): Promise<string | undefined> {
    if (this.path) {
      const stillThere = await stat(this.path).catch(() => undefined);
      if (stillThere) return this.path;
      this.path = undefined;
      this.lastSize = -1;
    }
    this.path = await findClaudeTranscriptForDirectory(workingDirectory, { sinceMs, rootDir });
    return this.path;
  }
}

/** A transcript entry, as far as the watcher cares. */
interface TranscriptEntry {
  type?: string;
  subtype?: string;
  message?: { content?: unknown };
}

/** Parse one transcript line. A cut-off line is not an entry. */
function parseEntry(line: string): TranscriptEntry | undefined {
  try {
    const parsed = JSON.parse(line) as TranscriptEntry;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The text of an assistant message. */
function assistantText(entry: TranscriptEntry): string | undefined {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(block => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    .map(block => (block as { text?: string }).text ?? '')
    .join(' ')
    .trim();
  if (!text) return undefined;
  return text.length > LAST_WORDS_LIMIT ? `${text.slice(0, LAST_WORDS_LIMIT)}…` : text;
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
