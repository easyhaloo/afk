/**
 * Handoff-Markdown session store — read-only adapter over the existing
 * `<worktree>/.afk/handoff/handoff-{iid}-{gen}.md` documents produced by
 * HandoffCoordinator. Used as the FALLBACK store in the SessionStoreChain
 * when no provider-native snapshot is available.
 *
 * Mapping:
 *   <worktree>/.afk/handoff/handoff-42-1.md -> runId="issue-42-gen-1"
 *
 * The handoff doc is plain Markdown, not a structured SessionSnapshot, so
 * the store synthesizes a SessionSnapshot with checkpoint=null (handoff
 * Markdown is for human + agent eyes, not for native restore).
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { SessionSnapshot } from '../agents/types';
import type {
  SessionStore,
  SessionSaveOptions,
  SessionSaveResult,
  SessionLoadOptions,
  SessionListOptions,
  SessionStoreEntry,
} from './types';
import { SessionNotFoundError } from './types';

const HANDOFF_DIR = '.afk/handoff';

export class HandoffSessionStore implements SessionStore {
  readonly name = 'handoff-md';
  readonly priority = 50; // lower than FileSessionStore — only fallback

  constructor(private readonly worktreePath: string) {}

  supportsProvider(_provider: string): boolean {
    // Handoff docs are provider-agnostic — any provider's handoff counts.
    return true;
  }

  async save(_options: SessionSaveOptions): Promise<SessionSaveResult> {
    throw new Error('HandoffSessionStore is read-only; HandoffCoordinator owns the markdown write path');
  }

  private fileForRunId(runId: string): string | null {
    // runId convention: 'issue-<iid>-gen-<n>' OR 'issue-<iid>-terminal'
    const m = runId.match(/^issue-(\d+)-(gen-(\d+)|terminal)$/);
    if (!m) return null;
    const iid = m[1];
    const gen = m[3] ?? 'terminal';
    return join(this.worktreePath, HANDOFF_DIR, `handoff-${iid}-${gen}.md`);
  }

  async load(options: SessionLoadOptions): Promise<SessionSnapshot> {
    const filePath = this.fileForRunId(options.runId);
    if (!filePath) {
      throw new SessionNotFoundError(options.runId);
    }
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SessionNotFoundError(options.runId);
      }
      throw err;
    }

    const m = options.runId.match(/^issue-(\d+)-(gen-(\d+)|terminal)$/);
    const generation = m && m[3] ? parseInt(m[3], 10) : 0;
    const stat = await fs.stat(filePath);

    return {
      sessionId: options.runId,
      generation,
      checkpoint: null,
      summary: content,
      capturedAt: stat.mtime.toISOString(),
    };
  }

  async list(options: SessionListOptions = {}): Promise<SessionStoreEntry[]> {
    const dir = join(this.worktreePath, HANDOFF_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const results: SessionStoreEntry[] = [];
    for (const name of entries) {
      // handoff-42-1.md  -> issue-42-gen-1
      // handoff-42-terminal.md -> issue-42-terminal
      const m = name.match(/^handoff-(\d+)-(\d+|terminal)\.md$/);
      if (!m) continue;
      const iid = m[1];
      const gen = m[2];
      const runId = gen === 'terminal' ? `issue-${iid}-terminal` : `issue-${iid}-gen-${gen}`;
      try {
        const stat = await fs.stat(join(dir, name));
        results.push({
          runId,
          provider: options.provider ?? 'unknown',
          capturedAt: stat.mtime.toISOString(),
        });
      } catch {
        // skip
      }
    }
    results.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return options.limit ? results.slice(0, options.limit) : results;
  }
}