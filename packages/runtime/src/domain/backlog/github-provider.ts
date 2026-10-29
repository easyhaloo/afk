import type { BacklogClaim, BacklogCreateInput, BacklogCreatePlan, BacklogExecutionMode, BacklogItem, BacklogKind, BacklogListOptions, BacklogProvider, BacklogState, NewReworkRecord, ReworkRecord, ReworkResolution } from './index.js';
import type { BacklogRelationUpdate } from './metadata-codec.js';
import { TrackerBacklogProvider, type TrackerBacklogAdapterOptions } from './tracker-provider.js';
import type { TrackerProvider } from '../tracker/types.js';

/** GitHub's production backlog boundary. Platform label mapping stays private. */
export class GitHubBacklogProvider implements BacklogProvider {
  readonly capabilities;
  private readonly implementation: TrackerBacklogProvider;

  constructor(tracker: TrackerProvider, options: TrackerBacklogAdapterOptions = {}) {
    if (tracker.platform !== 'github') throw new Error('GitHubBacklogProvider requires a GitHub tracker client');
    this.implementation = new TrackerBacklogProvider(tracker, options);
    this.capabilities = this.implementation.capabilities;
  }

  get(id: string): Promise<BacklogItem> { return this.implementation.get(id); }
  adopt(id: string): Promise<BacklogItem> { return this.implementation.adopt(id); }
  list(options?: BacklogListOptions): Promise<BacklogItem[]> { return this.implementation.list(options); }
  planCreate(input: BacklogCreateInput): Promise<BacklogCreatePlan> { return this.implementation.planCreate(input); }
  create(input: BacklogCreateInput): Promise<BacklogItem> { return this.implementation.create(input); }
  claim(id: string, owner: string): Promise<BacklogClaim | null> { return this.implementation.claim(id, owner); }
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void> { return this.implementation.transition(id, state, details); }
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> { return this.implementation.setExecutionMode(id, mode); }
  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord> { return this.implementation.createRework(id, record); }
  getActiveRework(id: string): Promise<ReworkRecord | undefined> { return this.implementation.getActiveRework(id); }
  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void> { return this.implementation.resolveRework(id, reworkId, resolution); }
  addTag(id: string, tag: string): Promise<void> { return this.implementation.addTag(id, tag); }
  removeTag(id: string, tag: string): Promise<void> { return this.implementation.removeTag(id, tag); }
  applyRelationUpdate(id: string, update: BacklogRelationUpdate): Promise<void> { return this.implementation.applyRelationUpdate(id, update); }
  applyRole(id: string, kind: BacklogKind): Promise<void> { return this.implementation.applyRole(id, kind); }
  initialize(): Promise<void> { return this.implementation.initialize(); }
  isRunnable(item: BacklogItem): Promise<boolean> { return this.implementation.isRunnable(item); }
}
