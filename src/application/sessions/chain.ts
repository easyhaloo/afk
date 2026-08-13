/**
 * Session store chain — see types.ts for the contract. This module exports
 * a default chain constructor that yields the standard priority order:
 *
 *   1. FileSessionStore  (provider-native snapshot if available)
 *   2. HandoffSessionStore  (Markdown fallback from HandoffCoordinator)
 *
 * The runner consults the chain on every context_high; whatever returns
 * first wins. If both miss, the runner falls back to its existing handoff
 * Markdown goal-text path.
 */

import { FileSessionStore } from './file-store';
import { HandoffSessionStore } from './handoff-store';
import { SessionStoreChain } from './types';

export function defaultSessionStoreChain(worktreePath: string): SessionStoreChain {
  return new SessionStoreChain([
    new FileSessionStore(worktreePath),
    new HandoffSessionStore(worktreePath),
  ]);
}

export { FileSessionStore } from './file-store';
export { HandoffSessionStore } from './handoff-store';
export * from './types';