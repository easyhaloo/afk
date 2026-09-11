import type { BacklogCreateInput, BacklogExecutionMode, BacklogItem, BacklogListOptions, BacklogProvider, BacklogState, NewReworkRecord, QABacklogProvider, ReworkRecord, ReworkResolution } from './index';

/**
 * Physical capability boundary for backlog management and QA. It forwards
 * only non-claim operations, so claim() is unavailable at both type and
 * runtime even when the wrapped provider supports implementation execution.
 */
export class ManagementBacklogProvider implements QABacklogProvider {
  constructor(private readonly provider: BacklogProvider) {}

  get(id: string): Promise<BacklogItem> { return this.provider.get(id); }
  list(options?: BacklogListOptions): Promise<BacklogItem[]> { return this.provider.list(options); }
  create(input: BacklogCreateInput): Promise<BacklogItem> { return this.provider.create(input); }
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void> { return this.provider.transition(id, state, details); }
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> { return this.provider.setExecutionMode(id, mode); }
  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord> { return this.provider.createRework(id, record); }
  getActiveRework(id: string): Promise<ReworkRecord | undefined> { return this.provider.getActiveRework(id); }
  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void> { return this.provider.resolveRework(id, reworkId, resolution); }
  addTag(id: string, tag: string): Promise<void> { return this.provider.addTag(id, tag); }
  removeTag(id: string, tag: string): Promise<void> { return this.provider.removeTag(id, tag); }
  initialize(): Promise<void> { return this.provider.initialize(); }
}
