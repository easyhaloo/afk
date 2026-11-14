import { workspaceDataDirectory } from '../../infrastructure/workspace.js';
/**
 * Handoff-Markdown session store — read-only adapter over the existing
 * `~/.afk/workspaces/<workspace-hash>/handoff/handoff-{iid}-{gen}.md` documents produced by
 * HandoffCoordinator. Used as the FALLBACK store in the SessionStoreChain
 * when no provider-native snapshot is available.
 *
 * Mapping:
 *   handoff/handoff-42-1.md -> runId="issue-42-gen-1"
 *
 * The handoff doc is plain Markdown, not a structured SessionSnapshot, so
 * the store synthesizes a SessionSnapshot with checkpoint=null (handoff
 * Markdown is for human + agent eyes, not for native restore).
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { SessionSnapshot } from '../../domain/agents/types.js';
import type {
  SessionStore,
  SessionSaveOptions,
  SessionSaveResult,
  SessionLoadOptions,
  SessionListOptions,
  SessionStoreEntry,
} from './types.js';
import { SessionNotFoundError } from './types.js';
import { handoffDocPath } from '../workflows/handoff.js';

const HANDOFF_DIR = 'handoff';

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
    const match = runId.match(/^issue-(.+)-(?:gen-(\d+)|terminal)$/);
    if (!match) return null;
    try {
      return handoffDocPath(this.worktreePath, match[1], match[2] === undefined ? 'terminal' : Number(match[2]));
    } catch {
      return null;
    }
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

    const match = options.runId.match(/-gen-(\d+)$/);
    const generation = match ? Number(match[1]) : 0;
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
    const dir = join(workspaceDataDirectory(this.worktreePath), HANDOFF_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const results: SessionStoreEntry[] = [];
    for (const name of entries) {
      const match = name.match(/^handoff-(.+)-(\d+|terminal)\.md$/);
      if (!match) continue;
      try {
        const identity = decodeURIComponent(match[1]);
        const gen = match[2];
        const runId = gen === 'terminal' ? `issue-${identity}-terminal` : `issue-${identity}-gen-${gen}`;
        if (this.fileForRunId(runId) !== join(dir, name)) continue;
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
