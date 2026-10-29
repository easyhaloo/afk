export type BacklogState = 'prd' | 'ready' | 'rework' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';
export type BacklogExecutionMode = 'afk' | 'hitl';

export type BacklogChangeRequest = {
  id: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  url?: string;
};
import { randomUUID } from 'node:crypto';
export type { BacklogClaim, ClaimLease } from './claim.js';
export { FilesystemClaimLock } from './claim.js';
export type { BacklogProviderCapabilities } from './initialization.js';
export { BACKLOG_METADATA } from './initialization.js';
export type { NewReworkRecord, ReworkRecord, ReworkResolution } from './rework-record.js';
export { extractBacklogTags, isInternalBacklogLabel, isWorkflowMetadataLabel, validateBusinessTag } from './tags.js';
export type { GlobalWorkItem, ProviderProjectRef, WorkItemId, WorkItemIdentityParts, WorkItemPlatform } from '../work-item/types.js';
export { encodeWorkItemIdForPath, formatWorkItemId, parseWorkItemId, WORK_ITEM_PLATFORMS, canonicalProjectKey, gitLabProjectHost } from '../work-item/identity.js';
export type { WorkItemScope } from '../work-item/identity.js';
export {
  BACKLOG_RELATION_PREFIX,
  canonicalizeBacklogReference,
  decodeBacklogMetadata,
  decodeBacklogRelations,
  encodeBacklogRelations,
  isBacklogRelationLabel,
} from './metadata-codec.js';
export type { BacklogMetadata, BacklogMetadataOptions, BacklogMetadataScope, BacklogRelations } from './metadata-codec.js';
export { buildBacklogGraph } from './graph.js';
export type { BacklogGraph, BacklogGraphSource } from './graph.js';
export { projectBacklogItem } from './projection.js';
export type { BacklogIssueView } from './projection.js';
export { deriveBacklogBranchName } from './branch-name.js';
import type { BacklogClaim } from './claim.js';
import type { NewReworkRecord, ReworkRecord, ReworkResolution } from './rework-record.js';
import type { ProviderProjectRef, WorkItemId, WorkItemScope } from '../work-item/types.js';
import { parseWorkItemId } from '../work-item/identity.js';
import { validateBusinessTag } from './tags.js';
import { deriveBacklogBranchName } from './branch-name.js';

export interface BacklogItem {
  /**
   * The canonical global identity of this item: `platform:projectKey#issueNumber`.
   *
   * One identity, whichever provider served the item. Two repositories with
   * the same issue number stay two different backlog items, and every
   * relationship edge names the item it points at unambiguously.
   */
  id: string;
  /** Canonical global identity supplied by provider inventory APIs. */
  workItemId?: WorkItemId;
  issueNumber?: number;
  project?: ProviderProjectRef;
  managed?: boolean;
  executionEligible?: boolean;
  title: string;
  description?: string;
  /** Organizational grouping only; it never selects a git base branch. */
  parentId?: string;
  /**
   * Explicit execution base: the canonical identity of the backlog whose
   * unmerged branch is the baseline, or the legacy `prd-N` branch token.
   */
  baseBacklogId?: string;
  dependsOn: string[];
  state: BacklogState;
  /**
   * The state the provider's workflow label records, when it has one.
   *
   * `state` is derived: a closed issue reads as `done` whatever its label
   * says, so it cannot tell a completed backlog from a closed issue whose
   * label still says "merge pending". The label is what a reviewer reads on
   * the platform, so reconciling it needs this raw value.
   */
  labeledState?: BacklogState;
  executionMode: BacklogExecutionMode;
  /** Provider-neutral business tags (never stage/mode metadata). */
  tags: string[];
  branchName: string;
  providerRef: string;
  /** Optional provider URL for read-only navigation (for example, opening in a browser). */
  webUrl?: string;
  changeRequest?: BacklogChangeRequest;
}

export interface BacklogCreateInput {
  title: string;
  description: string;
  stage?: 'ready' | 'prd';
  idempotencyKey?: string;
  parentId?: string;
  baseBacklogId?: string;
  dependsOn?: string[];
  executionMode?: BacklogExecutionMode;
  tags?: string[];
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
  /**
   * The canonical identity scope of the project this provider writes to.
   *
   * A relationship reference that names no project — a bare issue number —
   * resolves against this scope, so the stored label always carries a
   * canonical global identity.
   */
  readonly scope?: WorkItemScope;
  get(id: string): Promise<BacklogItem>;
  adopt?(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  create(input: BacklogCreateInput): Promise<BacklogItem>;
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
  readonly capabilities?: import('./initialization.js').BacklogProviderCapabilities;
  /** The canonical identity scope of the project this provider writes to. */
  readonly scope?: WorkItemScope;
  get(id: string): Promise<BacklogItem>;
  adopt?(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  create(input: BacklogCreateInput): Promise<BacklogItem>;
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

export class InMemoryBacklogProvider implements BacklogProvider {
  readonly capabilities = { atomicClaim: true, tags: true, initialization: true } as const;
  /** Synthetic scope: the in-memory backlog has no provider project. */
  readonly scope: WorkItemScope = { platform: 'github', projectKey: 'afk/in-memory' };
  private readonly items = new Map<string, BacklogItem>();
  private readonly owners = new Map<string, string>();
  private readonly reworks = new Map<string, ReworkRecord[]>();
  private claimChain: Promise<void> = Promise.resolve();

  constructor(items: BacklogItem[] = []) {
    for (const item of items) this.items.set(item.id, { ...item, dependsOn: [...item.dependsOn], tags: [...(item.tags ?? [])] });
  }

  async get(id: string): Promise<BacklogItem> {
    const item = this.items.get(this.itemKey(id));
    if (!item) throw new Error(`backlog item not found: ${id}`);
    return { ...item, dependsOn: [...item.dependsOn], tags: [...item.tags] };
  }

  /** Accept a canonical global identity as well as the stored key. */
  private itemKey(id: string): string {
    try {
      return String(parseWorkItemId(id).issueNumber);
    } catch {
      return id;
    }
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
      state: input.stage ?? 'ready',
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
      .some(candidate => candidate.parentId === item.id);
    if (hasIncompleteChild) return false;
    for (const dependencyId of item.dependsOn) {
      const dependency = this.items.get(dependencyId);
      if (!dependency || dependency.state !== 'done') return false;
    }
    return true;
  }
}
