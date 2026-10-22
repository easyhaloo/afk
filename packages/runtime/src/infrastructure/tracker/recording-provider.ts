import type {
  BacklogClaim,
  BacklogCreateInput,
  BacklogExecutionMode,
  BacklogItem,
  BacklogListOptions,
  BacklogProvider,
  BacklogProviderCapabilities,
  BacklogState,
  NewReworkRecord,
  ReworkRecord,
  ReworkResolution,
} from '../../domain/backlog/index.js';
import { recordTrackerActivity, type TrackerPlatform } from './store.js';

/** The provider project a recording provider belongs to. */
export interface TrackerIdentity {
  platform: TrackerPlatform;
  project: string;
  host?: string;
}

/**
 * A backlog provider that remembers what it saw.
 *
 * Every AFK entry point that reaches a provider — a backlog listing, one
 * issue lookup, an execution, the inventory — goes through this wrapper. It
 * writes the provider project, the local directory it was reached from, and
 * the issues it touched into the local tracker index. That index is what lets
 * a later command resolve a bare issue id, or a working directory, to the
 * provider project it belongs to, without the user configuring anything.
 *
 * Recording is a convenience: a failed write never fails the operation.
 */
export class RecordingBacklogProvider implements BacklogProvider {
  readonly capabilities?: BacklogProviderCapabilities;

  constructor(
    private readonly provider: BacklogProvider,
    private readonly identity: TrackerIdentity,
    private readonly cwd: string,
    private readonly stateRoot?: string,
  ) {
    this.capabilities = provider.capabilities;
  }

  async get(id: string): Promise<BacklogItem> {
    const item = await this.provider.get(id);
    this.record([item]);
    return item;
  }

  async adopt(id: string): Promise<BacklogItem> {
    if (!this.provider.adopt) throw new Error('backlog provider does not support explicit issue adoption');
    const item = await this.provider.adopt(id);
    this.record([item]);
    return item;
  }

  async list(options?: BacklogListOptions): Promise<BacklogItem[]> {
    const items = await this.provider.list(options);
    this.record(items);
    return items;
  }

  async create(input: BacklogCreateInput): Promise<BacklogItem> {
    const item = await this.provider.create(input);
    this.record([item]);
    return item;
  }

  claim(id: string, owner: string): Promise<BacklogClaim | null> {
    return this.provider.claim(id, owner);
  }

  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void> {
    return this.provider.transition(id, state, details);
  }

  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    return this.provider.setExecutionMode(id, mode);
  }

  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord> {
    return this.provider.createRework(id, record);
  }

  getActiveRework(id: string): Promise<ReworkRecord | undefined> {
    return this.provider.getActiveRework(id);
  }

  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void> {
    return this.provider.resolveRework(id, reworkId, resolution);
  }

  addTag(id: string, tag: string): Promise<void> {
    return this.provider.addTag(id, tag);
  }

  removeTag(id: string, tag: string): Promise<void> {
    return this.provider.removeTag(id, tag);
  }

  initialize(): Promise<void> {
    return this.provider.initialize();
  }

  isRunnable(item: BacklogItem): Promise<boolean> {
    return this.provider.isRunnable(item);
  }

  private record(items: readonly BacklogItem[]): void {
    const issues = items
      .filter(item => item?.id)
      .map(item => ({ id: String(item.id), title: item.title }));
    if (issues.length === 0) return;
    recordTrackerActivity({
      platform: this.identity.platform,
      project: this.identity.project,
      host: this.identity.host,
      cwd: this.cwd,
      issues,
    }, this.stateRoot);
  }
}
