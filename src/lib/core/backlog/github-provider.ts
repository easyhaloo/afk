import type { BacklogClaim, BacklogExecutionMode, BacklogItem, BacklogListOptions, BacklogProvider, BacklogState } from './index';
import { TrackerBacklogProvider, type TrackerBacklogAdapterOptions } from './tracker-adapter';
import type { TrackerProvider } from '../tracker/types';

/** GitHub's production backlog boundary. Platform label mapping stays private. */
export class GitHubBacklogProvider implements BacklogProvider {
  readonly capabilities;
  private readonly implementation: BacklogProvider;

  constructor(tracker: TrackerProvider, options: TrackerBacklogAdapterOptions = {}) {
    if (tracker.platform !== 'github') throw new Error('GitHubBacklogProvider requires a GitHub tracker client');
    this.implementation = new TrackerBacklogProvider(tracker, options);
    this.capabilities = this.implementation.capabilities;
  }

  get(id: string): Promise<BacklogItem> { return this.implementation.get(id); }
  list(options?: BacklogListOptions): Promise<BacklogItem[]> { return this.implementation.list(options); }
  claim(id: string, owner: string): Promise<BacklogClaim | null> { return this.implementation.claim(id, owner); }
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void> { return this.implementation.transition(id, state, details); }
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> { return this.implementation.setExecutionMode(id, mode); }
  addTag(id: string, tag: string): Promise<void> { return this.implementation.addTag(id, tag); }
  removeTag(id: string, tag: string): Promise<void> { return this.implementation.removeTag(id, tag); }
  initialize(): Promise<void> { return this.implementation.initialize(); }
  isRunnable(item: BacklogItem): Promise<boolean> { return this.implementation.isRunnable(item); }
}
