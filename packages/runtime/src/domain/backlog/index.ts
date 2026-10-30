export type BacklogState = 'ready' | 'rework' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';

/**
 * The role of a backlog item.
 *
 * A role is independent of the lifecycle: `prd` marks an organizational
 * parent that groups children and is never executable.
 */
export type BacklogKind = 'prd';
export type BacklogExecutionMode = 'afk' | 'hitl';

export type BacklogChangeRequest = {
  id: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  url?: string;
};
import { randomUUID } from 'node:crypto';
import type { BacklogRelationUpdate } from './metadata-codec.js';
import { formatWorkItemId } from '../work-item/identity.js';
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
  planRelationLabelDelta,
  planRoleLabelDelta,
} from './metadata-codec.js';
export type {
  BacklogLabelDelta,
  BacklogMetadata,
  BacklogMetadataOptions,
  BacklogMetadataScope,
  BacklogRelationUpdate,
  BacklogRelations,
} from './metadata-codec.js';
export { BACKLOG_KIND_LABELS } from './initialization.js';
export { BACKLOG_LABEL_PREFIX } from './initialization.js';
export type { BacklogCreatePlan } from './creation.js';
import type { BacklogCreatePlan } from './creation.js';
export { buildBacklogGraph, findDependencyCycle } from './graph.js';
export type { BacklogGraph, BacklogGraphSource } from './graph.js';
export { projectBacklogItem } from './projection.js';
export type { BacklogIssueView } from './projection.js';
export { deriveBacklogBranchName } from './branch-name.js';
import { applyExecutionBaseBranch, parseExecutionBaseBranch, renderBaseVersionSection } from './execution-base.js';
export { applyExecutionBaseBranch, parseExecutionBaseBranch, renderBaseVersionSection };
export { describeRunnability, evaluateRunnability, RUNNABLE_STATES } from './runnability.js';
export type { Runnability, RunnabilityReason, RunnabilitySubject } from './runnability.js';
import { evaluateRunnability, type Runnability } from './runnability.js';
import type { BacklogClaim } from './claim.js';
import type { NewReworkRecord, ReworkRecord, ReworkResolution } from './rework-record.js';
import type { ProviderProjectRef, WorkItemId, WorkItemScope } from '../work-item/types.js';
import { parseWorkItemId } from '../work-item/identity.js';
import { validateBusinessTag } from './tags.js';
import { planBacklogCreate } from './creation.js';
import { deriveBacklogBranchName } from './branch-name.js';
import {
  decodeBacklogRelations,
  encodeBacklogRelations,
  planRelationLabelDelta,
} from './metadata-codec.js';

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
  /** The role of the item; `prd` marks a parent that is never executable. */
  kind?: BacklogKind;
  title: string;
  description?: string;
  /**
   * The ref the work starts from, as the body declares it.
   *
   * A branch name means nothing outside the repository that has it, so it
   * travels in the body rather than in a label. The execution reads it back
   * from here, and the repository's default branch is only the fallback.
   */
  executionBase?: string;
  /** Organizational grouping only; it never selects a git base branch. */
  parentId?: string;
  /**
   * Explicit execution base: the canonical identity of the backlog whose
   * unmerged branch is the baseline, or the legacy `prd-N` branch token.
   */
  baseBacklogId?: string;
  dependsOn: string[];
  /** The lifecycle position. An organizational parent has none. */
  state?: BacklogState;
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
  /** The role of the created item; `prd` creates an organizational parent. */
  kind?: BacklogKind;
  idempotencyKey?: string;
  parentId?: string;
  baseBacklogId?: string;
  dependsOn?: string[];
  executionMode?: BacklogExecutionMode;
  tags?: string[];
}

export interface BacklogListOptions {
  state?: BacklogState;
  /** Filter by role; `prd` selects the organizational anchors. */
  kind?: BacklogKind;
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
  adopt?(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  /**
   * Plan the creation of one backlog item without writing anything.
   *
   * The plan belongs to the provider because the provider knows the project
   * the item is created in, and that project resolves a relationship
   * reference that names none. A dry run and the real creation must produce
   * the same plan, so both go through this one behaviour.
   */
  planCreate(input: BacklogCreateInput): Promise<BacklogCreatePlan>;
  create(input: BacklogCreateInput): Promise<BacklogItem>;
  addTag(id: string, tag: string): Promise<void>;
  removeTag(id: string, tag: string): Promise<void>;
  /**
   * Edit the relationship edges of an item that already exists.
   *
   * It is optional because a provider that only reads — a credential-scoped
   * inventory, for one — has nowhere to write an edge to.
   */
  applyRelationUpdate?(id: string, update: BacklogRelationUpdate): Promise<void>;
  /**
   * Give an item the organizational role of a PRD anchor.
   *
   * An anchor carries no lifecycle state and never runs by itself, so the
   * role replaces the stage and mode labels the item had.
   */
  applyRole?(id: string, kind: BacklogKind): Promise<void>;
  /**
   * Switch who runs an item.
   *
   * It is optional because a provider that only reads — a credential-scoped
   * inventory, for one — has nowhere to write the mode to.
   */
  applyMode?(id: string, mode: BacklogExecutionMode): Promise<void>;
  /**
   * Record the ref the work starts from.
   *
   * It is optional for the same reason the mode edit is: a provider that only
   * reads has nowhere to write the base to.
   */
  applyExecutionBase?(id: string, baseBranch: string): Promise<void>;
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
  get(id: string): Promise<BacklogItem>;
  adopt?(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  /** Plan the creation of one backlog item without writing anything. */
  planCreate(input: BacklogCreateInput): Promise<BacklogCreatePlan>;
  create(input: BacklogCreateInput): Promise<BacklogItem>;
  claim(id: string, owner: string): Promise<BacklogClaim | null>;
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void>;
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void>;
  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord>;
  getActiveRework(id: string): Promise<ReworkRecord | undefined>;
  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void>;
  addTag(id: string, tag: string): Promise<void>;
  removeTag(id: string, tag: string): Promise<void>;
  /** Edit the relationship edges of an item that already exists. */
  applyRelationUpdate(id: string, update: BacklogRelationUpdate): Promise<void>;
  /** Give an item the organizational role of a PRD anchor. */
  applyRole(id: string, kind: BacklogKind): Promise<void>;
  /** Switch who runs an item. */
  applyMode(id: string, mode: BacklogExecutionMode): Promise<void>;
  /** Record the ref the work starts from. */
  applyExecutionBase(id: string, baseBranch: string): Promise<void>;
  initialize(): Promise<void>;
  isRunnable(item: BacklogItem): Promise<boolean>;
  /**
   * Whether the item may start now, and what holds it back.
   *
   * A boolean answer cannot tell a queue from a deadlock, so the provider
   * reports the reason as well: which rule refused, and which dependencies
   * still have work to do.
   */
  explainRunnability(item: BacklogItem): Promise<Runnability>;
}

export class InMemoryBacklogProvider implements BacklogProvider {
  readonly capabilities = { atomicClaim: true, tags: true, initialization: true } as const;
  /** The synthetic project the in-memory backlog lives in. */
  private readonly project: WorkItemScope = { platform: 'github', projectKey: 'afk/in-memory' };
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

  async list(options: { state?: BacklogState; kind?: BacklogKind; executionMode?: BacklogExecutionMode; parentId?: string; tag?: string } = {}): Promise<BacklogItem[]> {
    return [...this.items.values()]
      .filter(item => options.state === undefined || item.state === options.state)
      .filter(item => options.kind === undefined || item.kind === options.kind)
      .filter(item => options.executionMode === undefined || item.executionMode === options.executionMode)
      .filter(item => options.parentId === undefined || item.parentId === options.parentId)
      .filter(item => options.tag === undefined || item.tags.includes(options.tag))
      .map(item => ({ ...item, dependsOn: [...item.dependsOn], tags: [...item.tags] }));
  }

  async planCreate(input: BacklogCreateInput): Promise<BacklogCreatePlan> {
    return planBacklogCreate(this, input, this.project);
  }

  async create(input: BacklogCreateInput): Promise<BacklogItem> {
    const plan = await this.planCreate(input);
    const id = String(Math.max(0, ...[...this.items.keys()].map(value => Number(value)).filter(Number.isSafeInteger)) + 1);
    const item: BacklogItem = {
      id,
      title: plan.title,
      description: input.description,
      ...(plan.parentId === undefined ? {} : { parentId: plan.parentId }),
      ...(plan.baseBacklogId === undefined ? {} : { baseBacklogId: plan.baseBacklogId }),
      dependsOn: [...plan.dependsOn],
      ...(plan.state === undefined ? {} : { state: plan.state }),
      ...(plan.kind === undefined ? {} : { kind: plan.kind }),
      executionMode: plan.executionMode,
      tags: [...plan.tags],
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

  /**
   * Edit the relationship edges of an item.
   *
   * The in-memory backlog keeps structured relations rather than labels, so
   * the edit travels through the same label planner the tracker-backed
   * provider uses. One planner means the two providers cannot drift apart on
   * what an edit means.
   */
  async applyRelationUpdate(id: string, update: BacklogRelationUpdate): Promise<void> {
    const item = await this.get(id);
    const labels = encodeBacklogRelations({
      ...(item.parentId ? { parentId: item.parentId as WorkItemId } : {}),
      ...(item.baseBacklogId ? { baseBacklogId: item.baseBacklogId as WorkItemId } : {}),
      dependsOn: item.dependsOn as WorkItemId[],
    });
    const selfId = formatWorkItemId({
      platform: this.project.platform,
      projectKey: this.project.projectKey,
      issueNumber: Number(item.id),
    });
    const delta = planRelationLabelDelta(labels, update, this.project, { selfId });
    const resulting = [...labels.filter(label => !delta.remove.includes(label)), ...delta.add];
    const relations = decodeBacklogRelations(resulting, this.project, { strict: false });
    if (relations.parentId) item.parentId = relations.parentId;
    else delete item.parentId;
    if (relations.baseBacklogId) item.baseBacklogId = relations.baseBacklogId;
    else delete item.baseBacklogId;
    item.dependsOn = [...relations.dependsOn];
    this.items.set(id, item);
  }

  /**
   * Give an item the organizational role of a PRD anchor.
   *
   * The role says what the item is: an anchor carries no lifecycle state and
   * never runs by itself, so the stage label goes away and the mode becomes
   * human-in-the-loop.
   */
  async applyRole(id: string, kind: BacklogKind): Promise<void> {
    const item = await this.get(id);
    item.kind = kind;
    delete item.state;
    item.executionMode = 'hitl';
    this.items.set(id, item);
  }

  /**
   * Switch who runs an item. Only the mode changes: the state, the role and
   * the relationships of the item stay where they are.
   */
  async applyMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    const item = await this.get(id);
    item.executionMode = mode;
    this.items.set(id, item);
  }

  /**
   * Record the ref the work starts from. Only the body changes.
   */
  async applyExecutionBase(id: string, baseBranch: string): Promise<void> {
    const item = await this.get(id);
    item.description = applyExecutionBaseBranch(item.description ?? '', baseBranch);
    this.items.set(id, item);
  }

  async initialize(): Promise<void> {
    // In-memory storage has no external metadata to create.
  }

  async isRunnable(item: BacklogItem): Promise<boolean> {
    return (await this.explainRunnability(item)).runnable;
  }

  async explainRunnability(item: BacklogItem): Promise<Runnability> {
    const hasChildren = [...this.items.values()].some(candidate => candidate.parentId === item.id);
    return evaluateRunnability({
      // The role vetoes first: an organizational anchor is never executable,
      // whatever lifecycle position it happens to carry.
      container: item.kind === 'prd',
      state: item.state,
      executionMode: item.executionMode,
      executionEligible: item.executionEligible,
      hasChildren,
      dependencies: item.dependsOn.map(id => ({ id, state: this.items.get(id)?.state })),
    });
  }
}
