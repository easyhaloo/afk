import { randomUUID } from 'node:crypto';
import {
  deriveBacklogBranchName,
  validateBusinessTag,
  type BacklogClaim,
  type BacklogCreateInput,
  type BacklogExecutionMode,
  type BacklogItem,
  type BacklogProvider,
  type BacklogState,
} from '@afk/application';
import type { NewReworkRecord, ReworkRecord, ReworkResolution } from '@afk/application';

/**
 * In-memory implementation of the backlog Port, used by tests and by the
 * `--no-provider` paths. It lives outside `@afk/application` because the
 * application package stays free of runtime dependencies.
 */
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

  async create(input: BacklogCreateInput): Promise<BacklogItem> {
    const title = input.title.trim();
    if (!title) throw new Error('backlog title must not be empty');
    const id = String(Math.max(0, ...[...this.items.keys()].map(value => Number(value)).filter(Number.isSafeInteger)) + 1);
    const item: BacklogItem = {
      id,
      title,
      description: input.description,
      parentId: input.parentId,
      baseBacklogId: input.baseBacklogId,
      dependsOn: [...new Set(input.dependsOn ?? [])],
      state: 'ready',
      executionMode: input.executionMode ?? 'afk',
      tags: [...new Set((input.tags ?? []).map(validateBusinessTag))],
      branchName: deriveBacklogBranchName(id),
      providerRef: `in-memory:${id}`,
    };
    this.items.set(id, item);
    return { ...item, dependsOn: [...item.dependsOn], tags: [...item.tags] };
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
    const active = records.find(record => record.status === 'open');
    if (active?.source === 'operator' && input.source === 'operator') {
      throw new Error(`backlog ${id} already has an open rework record`);
    }
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
    if (active) active.status = 'superseded';
    if (input.source === 'operator') {
      await this.transition(id, 'rework');
      await this.setExecutionMode(id, 'afk');
    }
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
