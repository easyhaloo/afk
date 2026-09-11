import type { BacklogExecutionMode, BacklogItem, BacklogListOptions, BacklogProvider, BacklogState, QABacklogProvider } from './index';

/**
 * Physical capability boundary for backlog management and QA. It forwards
 * only non-claim operations, so claim() is unavailable at both type and
 * runtime even when the wrapped provider supports implementation execution.
 */
export class ManagementBacklogProvider implements QABacklogProvider {
  constructor(private readonly provider: BacklogProvider) {}

  get(id: string): Promise<BacklogItem> { return this.provider.get(id); }
  list(options?: BacklogListOptions): Promise<BacklogItem[]> { return this.provider.list(options); }
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void> { return this.provider.transition(id, state, details); }
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> { return this.provider.setExecutionMode(id, mode); }
  addTag(id: string, tag: string): Promise<void> { return this.provider.addTag(id, tag); }
  removeTag(id: string, tag: string): Promise<void> { return this.provider.removeTag(id, tag); }
  initialize(): Promise<void> { return this.provider.initialize(); }
}
