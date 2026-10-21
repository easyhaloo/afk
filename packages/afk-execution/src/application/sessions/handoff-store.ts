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

import { AFK_HANDOFF_DIRECTORY } from '@afk/core';
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
import { handoffDocName, parseHandoffDocName, parseRunId, runIdFor } from '../run-identity.js';



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
    const identity = parseRunId(runId);
    if (!identity) return null;
    return join(this.worktreePath, AFK_HANDOFF_DIRECTORY, handoffDocName(identity));
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

    const identity = parseRunId(options.runId);
    const generation = identity && identity.generation !== 'terminal' ? identity.generation : 0;
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
    const dir = join(this.worktreePath, AFK_HANDOFF_DIRECTORY);
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
      const identity = parseHandoffDocName(name);
      if (!identity) continue;
      const runId = runIdFor(identity);
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