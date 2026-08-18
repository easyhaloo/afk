export type BacklogState = 'ready' | 'rework' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';
export type BacklogExecutionMode = 'afk' | 'hitl';
import { randomUUID } from 'node:crypto';
export type { BacklogClaim, ClaimLease } from './claim';
export { FilesystemClaimLock } from './claim';
export type { BacklogProviderCapabilities } from './initialization';
export { BACKLOG_METADATA } from './initialization';
export type { NewReworkRecord, ReworkRecord, ReworkResolution } from './rework-record';
export { extractBacklogTags, isInternalBacklogLabel, isWorkflowMetadataLabel, validateBusinessTag } from './tags';
import type { BacklogClaim } from './claim';
import type { NewReworkRecord, ReworkRecord, ReworkResolution } from './rework-record';
import { validateBusinessTag } from './tags';

export interface BacklogItem {
  id: string;
  title: string;
  description?: string;
  parentId?: string;
  dependsOn: string[];
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  /** Provider-neutral business tags (never stage/mode metadata). */
  tags: string[];
  branchName: string;
  providerRef: string;
  /** Optional provider URL for read-only navigation (for example, opening in a browser). */
  webUrl?: string;
}

export interface BacklogListOptions {
  state?: BacklogState;
  executionMode?: BacklogExecutionMode;
  parentId?: string;
  tag?: string;
}

/**
 * The non-execution surface shared by backlog administration and QA.
 * It deliberately omits claim() so callers cannot start implementation work.
 */
export interface BacklogManagementProvider {
  get(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  addTag(id: string, tag: string): Promise<void>;
  removeTag(id: string, tag: string): Promise<void>;
  initialize(): Promise<void>;
}

/** QA may update lifecycle state, but it never claims implementation work. */
export interface QABacklogProvider extends BacklogManagementProvider {
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void>;
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void>;
  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord>;
  getActiveRework(id: string): Promise<ReworkRecord | undefined>;
  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void>;
}

export interface BacklogProvider {
  readonly capabilities?: import('./initialization').BacklogProviderCapabilities;
  get(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  claim(id: string, owner: string): Promise<BacklogClaim | null>;
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void>;
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void>;
  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord>;
  getActiveRework(id: string): Promise<ReworkRecord | undefined>;
  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void>;
  addTag(id: string, tag: string): Promise<void>;
  removeTag(id: string, tag: string): Promise<void>;
  initialize(): Promise<void>;
  isRunnable(item: BacklogItem): Promise<boolean>;
}

export function deriveBacklogBranchName(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('backlog id must contain at least one usable character');
  return `afk/backlog-${normalized}`;
}

export class InMemoryBacklogProvider implements BacklogProvider {
  readonly capabilities = { atomicClaim: true, tags: true, initialization: true } as const;
  private readonly items = new Map<string, BacklogItem>();
  private readonly owners = new Map<string, string>();
  private readonly reworks = new Map<string, ReworkRecord[]>();
  private claimChain: Promise<void> = Promise.resolve();

  constructor(items: BacklogItem[] = []) {
    for (const item of items) this.items.set(item.id, { ...item, dependsOn: [...item.dependsOn], tags: [...(item.tags ?? [])] });
  }

  async get(id: string): Promise<BacklogItem> {
    const item = this.items.get(id);
    if (!item) throw new Error(`backlog item not found: ${id}`);
    return { ...item, dependsOn: [...item.dependsOn], tags: [...item.tags] };
  }

  async list(options: { state?: BacklogState; executionMode?: BacklogExecutionMode; parentId?: string; tag?: string } = {}): Promise<BacklogItem[]> {
    return [...this.items.values()]
      .filter(item => options.state === undefined || item.state === options.state)
      .filter(item => options.executionMode === undefined || item.executionMode === options.executionMode)
      .filter(item => options.parentId === undefined || item.parentId === options.parentId)
      .filter(item => options.tag === undefined || item.tags.includes(options.tag))
      .map(item => ({ ...item, dependsOn: [...item.dependsOn], tags: [...item.tags] }));
  }

  async claim(id: string, owner: string): Promise<BacklogClaim | null> {
    let result: BacklogClaim | null = null;
    const previous = this.claimChain;
    let release!: () => void;
    this.claimChain = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const item = await this.get(id);
      if ((item.state !== 'ready' && item.state !== 'rework') || !(await this.isRunnable(item))) return null;
      this.owners.set(id, owner);
      item.state = 'in_progress';
      this.items.set(id, item);
      result = {
        item: { ...item, dependsOn: [...item.dependsOn], tags: [...item.tags] },
        claimId: `in-memory:${id}:${owner}:${randomUUID()}`,
        heartbeat: async () => {},
        release: async () => {},
      };
      return result;
    } finally {
      release();
    }
  }

  async transition(id: string, state: BacklogState, _details?: { reason?: string; changeId?: string }): Promise<void> {
    const item = await this.get(id);
    item.state = state;
    if (state === 'blocked') item.executionMode = 'hitl';
    this.items.set(id, item);
  }

  async setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    const item = await this.get(id);
    item.executionMode = mode;
    this.items.set(id, item);
  }

  async createRework(id: string, input: NewReworkRecord): Promise<ReworkRecord> {
    const records = this.reworks.get(id) ?? [];
    if (records.some(record => record.status === 'open')) throw new Error(`backlog ${id} already has an open rework record`);
    const record: ReworkRecord = {
      ...input,
      version: 1,
      id: `r${records.length + 1}`,
      attempt: records.length + 1,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    records.push(record);
    this.reworks.set(id, records);
    await this.transition(id, 'rework');
    await this.setExecutionMode(id, 'afk');
    return { ...record, failedCriteria: [...record.failedCriteria], requiredChecks: [...record.requiredChecks] };
  }

  async getActiveRework(id: string): Promise<ReworkRecord | undefined> {
    const record = (this.reworks.get(id) ?? []).find(candidate => candidate.status === 'open');
    return record && { ...record, failedCriteria: [...record.failedCriteria], requiredChecks: [...record.requiredChecks] };
  }

  async resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void> {
    const records = this.reworks.get(id) ?? [];
    const record = records.find(candidate => candidate.id === reworkId);
    if (!record || record.status !== 'open') throw new Error(`open rework record not found: ${reworkId}`);
    record.status = 'resolved';
    record.resolvedAt = new Date().toISOString();
    record.resolutionSummary = resolution.summary;
  }

  async addTag(id: string, tag: string): Promise<void> {
    tag = validateBusinessTag(tag);
    const item = await this.get(id);
    if (!item.tags.includes(tag)) item.tags.push(tag);
    this.items.set(id, item);
  }

  async removeTag(id: string, tag: string): Promise<void> {
    const item = await this.get(id);
    item.tags = item.tags.filter(existing => existing !== tag);
    this.items.set(id, item);
  }

  async initialize(): Promise<void> {
    // In-memory storage has no external metadata to create.
  }

  async isRunnable(item: BacklogItem): Promise<boolean> {
    if ((item.state !== 'ready' && item.state !== 'rework') || item.executionMode !== 'afk') return false;
    const hasIncompleteChild = [...this.items.values()]
      .some(candidate => candidate.parentId === item.id && candidate.state !== 'done');
    if (hasIncompleteChild) return false;
    for (const dependencyId of item.dependsOn) {
      const dependency = this.items.get(dependencyId);
      if (!dependency || dependency.state !== 'done') return false;
    }
    return true;
  }
}
