/**
 * Session store types — abstraction over provider-native session persistence
 * (e.g., Claude Code session dir, cursor-agent --resume id) and the AFK
 * handoff-Markdown fallback.
 *
 * Phase 4 (EXECUTION-DESIGN.md §12 阶段 4):
 *   - Provider-specific session store (FileSessionStore for native snapshots)
 *   - HandoffSessionStore wraps the existing handoff-*.md docs
 *   - Native resume preferred; handoff Markdown fallback when corrupt / absent
 *
 * The runner's phase loop consults a SessionStore chain in priority order;
 * the first store that returns a valid snapshot wins.
 */

import type { SessionSnapshot } from '../agents/types';

/** Errors thrown by session stores. Distinct error type so the runner can
 *  detect 'corrupt' specifically and fall back without aborting the phase. */
export class SessionCorruptError extends Error {
  constructor(message: string, public readonly storeName: string, public readonly cause?: unknown) {
    super(`session corrupt in ${storeName}: ${message}`);
    this.name = 'SessionCorruptError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`session not found: ${runId}`);
    this.name = 'SessionNotFoundError';
  }
}

/** Result of a session-store save operation. */
export interface SessionSaveResult {
  /** Where the snapshot was persisted (store-specific path). */
  path: string;
  /** Hex sha256 of the serialized snapshot. */
  checksum: string;
  /** Provider name this snapshot belongs to. */
  provider: string;
}

/** Options for save(). */
export interface SessionSaveOptions {
  /** Identifier for the run (issue iid + generation, e.g. 'issue-42-gen-1'). */
  runId: string;
  /** Provider name (e.g., 'claude-code'). */
  provider: string;
  /** The snapshot to persist. */
  snapshot: SessionSnapshot;
}

/** Options for load(). */
export interface SessionLoadOptions {
  /** Identifier for the run to load. */
  runId: string;
  /** Optional expected checksum — if it does not match, throw SessionCorruptError. */
  expectedChecksum?: string;
}

/** Options for list(). */
export interface SessionListOptions {
  /** Filter by provider (optional). */
  provider?: string;
  /** Limit count (most recent first). */
  limit?: number;
}

/** Minimal store info returned by list(). */
export interface SessionStoreEntry {
  runId: string;
  provider: string;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Optional checksum for callers that want to verify. */
  checksum?: string;
}

/**
 * Session store interface — the runner queries a chain of these in priority
 * order. The first one that returns a snapshot wins; later stores are skipped.
 *
 * Stores MUST throw SessionCorruptError (not generic Error) on data integrity
 * failures so the runner can safely fall back without aborting the phase.
 */
export interface SessionStore {
  readonly name: string;
  /** Order in the lookup chain (lower = higher priority). */
  readonly priority: number;

  /** Whether this store can save a snapshot for the given provider. */
  supportsProvider(provider: string): boolean;

  /** Save a snapshot. Returns metadata about where it landed. */
  save(options: SessionSaveOptions): Promise<SessionSaveResult>;

  /** Load a snapshot. Throws SessionNotFoundError if absent, SessionCorruptError if invalid. */
  load(options: SessionLoadOptions): Promise<SessionSnapshot>;

  /** List known sessions, most-recent first. */
  list(options?: SessionListOptions): Promise<SessionStoreEntry[]>;
}

/**
 * Session store chain — walks a priority-ordered list of stores; the first
 * one that returns a snapshot wins. Used by the runner for native-resume
 * preference with safe fallback.
 */
export class SessionStoreChain {
  constructor(private readonly stores: SessionStore[]) {}

  /**
   * Try each store in priority order. Returns the first successful load.
   * SessionCorruptError from one store falls through to the next; only
   * SessionNotFoundError surfaces as 'not found' if every store misses.
   */
  async loadFirst(options: SessionLoadOptions): Promise<{ snapshot: SessionSnapshot; storeName: string } | null> {
    let lastError: unknown = null;
    for (const store of this.stores) {
      try {
        const snapshot = await store.load(options);
        return { snapshot, storeName: store.name };
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          lastError = err;
          continue;
        }
        if (err instanceof SessionCorruptError) {
          // Surface corruption but keep falling back — the design says
          // session 损坏时能安全降级.
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    void lastError;
    return null;
  }

  /** Save to the first store that supports the given provider. */
  async saveFirst(options: SessionSaveOptions): Promise<SessionSaveResult> {
    for (const store of this.stores) {
      if (store.supportsProvider(options.provider)) {
        return store.save(options);
      }
    }
    throw new Error(`no session store supports provider '${options.provider}'`);
  }
}