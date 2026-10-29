import type { BacklogChangeRequest, BacklogClaim, BacklogCreateInput, BacklogExecutionMode, BacklogItem, BacklogProvider, BacklogState } from './index.js';
import { deriveBacklogBranchName } from './index.js';
import { FilesystemClaimLock, type ExpiredClaim } from './claim.js';
import {
  NativeOrLockedClaimStrategy,
  type AtomicClaim,
  type AtomicClaimPredicate,
  type ClaimLock,
  type ClaimLockFactory,
} from './claim-strategy.js';
import { BACKLOG_METADATA, backlogMetadataLabelSpecs, type BacklogProviderCapabilities } from './initialization.js';
import { extractBacklogTags, isInternalBacklogLabel, isWorkflowMetadataLabel, validateBusinessTag } from './tags.js';
import { latestOpenRework, parseReworkRecord, renderReworkRecord, type NewReworkRecord, type ReworkRecord, type ReworkResolution } from './rework-record.js';
import type { LabelDelta, TrackerProvider, TrackedIssue } from '../tracker/types.js';
import { parseWorkItemId } from '../work-item/identity.js';
import { planBacklogCreate, renderBacklogDescription, validateBacklogRelations } from './creation.js';

const STATE_LABELS: Record<BacklogState, string> = BACKLOG_METADATA.stateLabels;
const MODE_LABELS = BACKLOG_METADATA.executionModeLabels;

export type { AtomicClaimPredicate } from './claim-strategy.js';

export interface TrackerBacklogAdapterOptions {
  /** Platform-specific conditional update. It takes precedence over a local lease. */
  atomicClaim?: AtomicClaim;
  /** Preconfigured lock; without a recovery callback it deliberately fails closed on expiry. */
  claimLock?: ClaimLock;
  /** Creates a lock with this provider's expiry-recovery callback attached. */
  claimLockFactory?: ClaimLockFactory;
  /** Lease duration for the local fallback claim path. */
  claimTtlMs?: number;
  /** Optional provider-side metadata setup hook (labels are adapter details). */
  ensureMetadata?: (metadata: typeof BACKLOG_METADATA) => Promise<void>;
}

export class TrackerBacklogProvider implements BacklogProvider {
  readonly capabilities: BacklogProviderCapabilities;
  private readonly atomicClaim?: TrackerBacklogAdapterOptions['atomicClaim'];
  private readonly claimStrategy: NativeOrLockedClaimStrategy;

  constructor(private readonly tracker: TrackerProvider, options: TrackerBacklogAdapterOptions = {}) {
    this.options = options;
    this.atomicClaim = options.atomicClaim;
    const onExpiredClaim = (key: string, claim: ExpiredClaim) => this.recoverExpiredClaim(key, claim);
    const claimLock = options.claimLock
      ?? options.claimLockFactory?.(onExpiredClaim)
      ?? new FilesystemClaimLock(undefined, { onExpiredClaim });
    this.claimStrategy = new NativeOrLockedClaimStrategy({
      atomicClaim: this.atomicClaim,
      claimLock,
      claimKey: id => this.claimKey(id),
      claimTtlMs: options.claimTtlMs ?? 60 * 60_000,
      read: id => this.get(id),
      isRunnable: item => this.isRunnable(item),
      transitionToInProgress: id => this.transition(id, 'in_progress'),
      isConfirmedClaim: item => this.isConfirmedClaim(item),
      blockAndRouteToHitl: (id, reason) => this.blockAndRouteToHitl(id, reason),
    });
    this.capabilities = { atomicClaim: true, tags: true, initialization: true };
  }

  async get(id: string): Promise<BacklogItem> {
    if (id.includes(':')) {
      const target = this.relationTarget(id);
      const item = await new TrackerBacklogProvider(target.tracker, this.options).get(String(target.issueId));
      return { ...item, id: parseWorkItemId(id).id };
    }
    const issue = await this.tracker.getIssue(this.issueId(id));
    const changes = await this.tracker.listMRs({ state: 'all' });
    return this.withChangeRequest(toBacklogItem(issue), issue.labels, changes);
  }

  async adopt(id: string): Promise<BacklogItem> {
    const issueId = this.issueId(id);
    const issue = await this.tracker.getIssue(issueId);
    if (issue.state !== 'opened') throw new Error(`backlog ${id} must be open for adoption`);
    const desired = [STATE_LABELS.ready, MODE_LABELS.afk];
    const metadata = issue.labels.filter(isInternalBacklogLabel)
      .map(label => label.replace(/^depends_on::/, 'depends-on::'));
    if (new Set(metadata).size !== metadata.length
      || issue.labels.some(label => isWorkflowMetadataLabel(label) && !desired.includes(label))) {
      throw new Error(`invalid adoption metadata for backlog ${id}: expected ready/afk without duplicate or conflicting AFK labels`);
    }
    try {
      validateBacklogRelations(metadata, [String(issueId), `${this.tracker.platform}:${this.tracker.projectId}#${issueId}`,
        `${this.tracker.platform}:${this.tracker.providerHost}/${this.tracker.projectId}#${issueId}`]);
    } catch (error) {
      throw new Error(`invalid adoption metadata for backlog ${id}: ${(error as Error).message}`);
    }
    const delta = labelDelta(issue.labels, desired, isWorkflowMetadataLabel);
    if (delta.add.length) {
      await this.initialize();
      await this.applyLabelDelta(issueId, delta);
    }
    return this.get(id);
  }

  async list(options: { state?: BacklogState; executionMode?: BacklogExecutionMode; parentId?: string; tag?: string } = {}): Promise<BacklogItem[]> {
    // Read all issues so parent readiness can be derived from every child,
    // including completed children and dependencies.
    const issues = await this.tracker.listIssues({ state: 'all' });
    const changes = await this.tracker.listMRs({ state: 'all' });
    const items = (await Promise.all(issues.map(issue => this.withChangeRequest(toBacklogItem(issue), issue.labels, changes)))).filter(item =>
      (options.state === undefined || item.state === options.state) &&
      (options.executionMode === undefined || item.executionMode === options.executionMode) &&
      (options.parentId === undefined || this.sameReference(item.parentId, options.parentId)) &&
      (options.tag === undefined || item.tags.includes(options.tag)),
    );
    return items;
  }

  async create(input: BacklogCreateInput): Promise<BacklogItem> {
    const plan = await planBacklogCreate(this, input);
    if (plan.idempotencyLabel) {
      // ponytail: label lookup covers sequential retries; concurrent creators need a distributed lock.
      const existing = (await this.tracker.listIssues({ state: 'all', labels: [plan.idempotencyLabel] }))
        .filter(issue => issue.labels.includes(plan.idempotencyLabel!));
      if (existing.length > 1) throw new Error('idempotency key matches multiple backlog items');
      if (existing.length) return this.get(String(existing[0].id));
    }
    const dependencyTargets = plan.dependsOn.map(id => this.relationTarget(id));
    await this.initialize();
    const relationshipLabels = plan.labels.filter(label => isInternalBacklogLabel(label) && !isWorkflowMetadataLabel(label));
    if (relationshipLabels.length && this.tracker.ensureBacklogMetadata) {
      await this.tracker.ensureBacklogMetadata(relationshipLabels.map(name => ({ name, color: 'C5DEF5', description: 'AFK backlog metadata' })));
    }
    const id = await this.tracker.createIssue({
      title: plan.title,
      description: plan.description,
      labels: plan.labels,
    });
    for (const target of dependencyTargets) {
      if (target.tracker === this.tracker) await this.tracker.linkIssues(id, target.issueId, 'blocked_by');
      else await this.tracker.linkIssues(id, target.issueId, 'blocked_by', String(target.tracker.projectId));
    }
    const created = await this.get(String(id));
    if (!created.webUrl) return created;
    await this.tracker.updateIssue(id, {
      description: renderBacklogDescription(input.description, { ...plan.links, self: created }),
    });
    return this.get(String(id));
  }

  async claim(id: string, owner: string): Promise<BacklogClaim | null> {
    return this.claimStrategy.claim(id, owner);
  }

  async transition(id: string, state: BacklogState, _details?: { reason?: string; changeId?: string }): Promise<void> {
    const issueId = this.issueId(id);
    const issue = await this.tracker.getIssue(issueId);
    const currentMode = issue.labels.find(label => Object.values(MODE_LABELS).includes(label));
    const mode = state === 'blocked' ? MODE_LABELS.hitl : currentMode ?? MODE_LABELS.afk;
    await this.updateWorkflowLabels(issueId, issue.labels, [STATE_LABELS[state], mode]);
    if (state === 'done') await this.tracker.updateIssue(issueId, { state: 'closed' });
  }

  private async withChangeRequest(item: BacklogItem, labels: readonly string[], changes: Awaited<ReturnType<TrackerProvider['listMRs']>>): Promise<BacklogItem> {
    if (!labels.includes(STATE_LABELS.merge_ready) && !labels.includes(STATE_LABELS.done)) return item;
    const candidate = changes.find(change => change.sourceBranch === `${item.branchName}-qa`)
      ?? changes.find(change => change.sourceBranch === item.branchName);
    if (!candidate) return item;
    const change = await this.tracker.getMR(candidate.id);
    const state: BacklogChangeRequest['state'] = change.state === 'opened' ? 'open' : change.state;
    return {
      ...item,
      changeRequest: {
        id: String(change.id),
        state,
        sourceBranch: change.sourceBranch,
        targetBranch: change.targetBranch,
        ...(change.url ? { url: change.url } : {}),
      },
    };
  }

  async setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    const issueId = this.issueId(id);
    const issue = await this.tracker.getIssue(issueId);
    const currentStage = issue.labels.find(label => Object.values(STATE_LABELS).includes(label));
    if (currentStage) await this.updateWorkflowLabels(issueId, issue.labels, [currentStage, MODE_LABELS[mode]]);
    else await this.tracker.updateLabels(issueId, labelDelta(issue.labels, [MODE_LABELS[mode]], isModeLabel));
  }

  private async updateWorkflowLabels(issueId: number, current: string[], desired: string[]): Promise<void> {
    await this.applyLabelDelta(issueId, labelDelta(current, desired, isWorkflowMetadataLabel));
  }

  private async applyLabelDelta(issueId: number, delta: LabelDelta): Promise<void> {
    if (delta.add.length === 0 && delta.remove.length === 0) return;
    await this.tracker.updateLabels(issueId, delta);
  }

  async createRework(id: string, input: NewReworkRecord): Promise<ReworkRecord> {
    const issueId = this.issueId(id);
    const comments = await this.tracker.listIssueComments(issueId);
    const active = latestOpenRework(comments);
    if (active?.record.source === 'operator' && input.source === 'operator') {
      throw new Error(`backlog ${id} already has an open rework record`);
    }
    const attempts = comments
      .map(parseReworkRecord)
      .filter((entry): entry is NonNullable<ReturnType<typeof parseReworkRecord>> => entry !== undefined)
      .map(entry => entry.record.attempt);
    const attempt = (attempts.length ? Math.max(...attempts) : 0) + 1;
    const record: ReworkRecord = {
      ...input,
      version: 1,
      id: `r${attempt}`,
      attempt,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    await this.tracker.addComment(issueId, renderReworkRecord(record));
    if (active) {
      try {
        await this.tracker.updateIssueComment(issueId, active.commentId, renderReworkRecord({ ...active.record, status: 'superseded' }));
      } catch (error) {
        await this.supersedeCreatedRework(issueId, record).catch(() => {});
        throw error;
      }
    }
    if (input.source === 'operator') {
      await this.transition(id, 'rework');
      await this.setExecutionMode(id, 'afk');
    }
    return record;
  }

  private async supersedeCreatedRework(issueId: number, record: ReworkRecord): Promise<void> {
    const comments = await this.tracker.listIssueComments(issueId);
    const created = comments
      .map(parseReworkRecord)
      .find(entry => entry?.record.id === record.id && entry.record.status === 'open');
    if (created) {
      await this.tracker.updateIssueComment(issueId, created.commentId, renderReworkRecord({ ...record, status: 'superseded' }));
    }
  }

  async getActiveRework(id: string): Promise<ReworkRecord | undefined> {
    const comments = await this.tracker.listIssueComments(this.issueId(id));
    return latestOpenRework(comments)?.record;
  }

  async resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void> {
    const issueId = this.issueId(id);
    const comments = await this.tracker.listIssueComments(issueId);
    const target = comments
      .map(parseReworkRecord)
      .find((entry): entry is NonNullable<ReturnType<typeof parseReworkRecord>> => entry?.record.id === reworkId && entry.record.status === 'open');
    if (!target) throw new Error(`open rework record not found: ${reworkId}`);
    const record: ReworkRecord = {
      ...target.record,
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
      resolutionSummary: resolution.summary,
    };
    await this.tracker.updateIssueComment(issueId, target.commentId, renderReworkRecord(record));
  }

  async addTag(id: string, tag: string): Promise<void> {
    const normalized = validateBusinessTag(tag);
    const issueId = this.issueId(id);
    const issue = await this.tracker.getIssue(issueId);
    if (issue.labels.includes(normalized)) return;
    await this.tracker.updateLabels(issueId, { add: [normalized], remove: [] });
  }

  async removeTag(id: string, tag: string): Promise<void> {
    const normalized = validateBusinessTag(tag);
    const issueId = this.issueId(id);
    const issue = await this.tracker.getIssue(issueId);
    if (!issue.labels.includes(normalized)) return;
    await this.tracker.updateLabels(issueId, { add: [], remove: [normalized] });
  }

  async initialize(): Promise<void> {
    // Prefer an adapter-native provisioning hook. It creates AFK lifecycle labels
    // before issue creation while preserving labels that the repository owns.
    const options = this.options;
    if (options.ensureMetadata) {
      await options.ensureMetadata(BACKLOG_METADATA);
      return;
    }
    if (this.tracker.ensureBacklogMetadata) {
      await this.tracker.ensureBacklogMetadata(backlogMetadataLabelSpecs());
      return;
    }
    await this.tracker.listIssues({ state: 'all', perPage: 1 });
  }

  async isRunnable(item: BacklogItem): Promise<boolean> {
    if (item.executionEligible === false || (item.state !== 'ready' && item.state !== 'rework') || item.executionMode !== 'afk') return false;
    const children = await this.list({ parentId: item.id });
    if (children.length) return false;
    for (const dependencyId of item.dependsOn) {
      const dependency = await this.get(dependencyId).catch(() => null);
      if (!dependency || dependency.state !== 'done') return false;
    }
    return true;
  }

  private async isConfirmedClaim(item: BacklogItem): Promise<boolean> {
    if (item.state !== 'in_progress' || item.executionMode !== 'afk') return false;
    const children = await this.list({ parentId: item.id });
    if (children.length) return false;
    for (const dependencyId of item.dependsOn) {
      const dependency = await this.get(dependencyId).catch(() => null);
      if (!dependency || dependency.state !== 'done') return false;
    }
    return true;
  }

  private claimKey(id: string): string {
    return `${this.tracker.platform}/${this.tracker.projectId}/${this.issueId(id)}`;
  }

  private async recoverExpiredClaim(key: string, _claim: ExpiredClaim): Promise<boolean> {
    const prefix = `${this.tracker.platform}/${this.tracker.projectId}/`;
    if (!key.startsWith(prefix)) return false;
    const backlogId = key.slice(prefix.length);
    if (!backlogId || backlogId.includes('/')) return false;
    try {
      if (key !== this.claimKey(backlogId)) return false;
      return this.blockAndRouteToHitl(backlogId, 'filesystem claim lease expired');
    } catch {
      return false;
    }
  }

  private async blockAndRouteToHitl(id: string, _reason?: string): Promise<boolean> {
    try {
      await this.transition(id, 'blocked');
      const blocked = await this.get(id);
      return blocked.state === 'blocked' && blocked.executionMode === 'hitl';
    } catch {
      return false;
    }
  }

  private issueId(id: string): number {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`tracker backlog id must be a positive integer: ${id}`);
    return value;
  }

  private relationTarget(id: string): { tracker: TrackerProvider; issueId: number } {
    if (!id.includes(':')) return { tracker: this.tracker, issueId: this.issueId(id) };
    const reference = parseWorkItemId(id);
    if (reference.platform !== this.tracker.platform) throw new Error('cross-platform backlog relationships are not supported');
    const localProjects = [String(this.tracker.projectId), `${this.tracker.providerHost}/${this.tracker.projectId}`];
    if (localProjects.includes(reference.projectKey)) return { tracker: this.tracker, issueId: reference.issueNumber };
    if (!this.tracker.forProject) throw new Error('tracker does not support cross-project backlog relationships');
    return { tracker: this.tracker.forProject(reference.projectKey), issueId: reference.issueNumber };
  }

  private sameReference(left: string | undefined, right: string): boolean {
    if (left === right) return true;
    if (!left) return false;
    try {
      const leftTarget = this.relationTarget(left);
      const rightTarget = this.relationTarget(right);
      return leftTarget.issueId === rightTarget.issueId && leftTarget.tracker.projectId === rightTarget.tracker.projectId;
    } catch {
      return false;
    }
  }

  private readonly options: TrackerBacklogAdapterOptions;
}

function isModeLabel(label: string): boolean {
  return Object.values(MODE_LABELS).some(modeLabel => modeLabel === label);
}

function labelDelta(current: readonly string[], desired: readonly string[], isWorkflowLabel: (label: string) => boolean): LabelDelta {
  const currentWorkflow = [...new Set(current.filter(isWorkflowLabel))];
  const desiredWorkflow = [...new Set(desired)];
  return {
    add: desiredWorkflow.filter(label => !currentWorkflow.includes(label)),
    remove: currentWorkflow.filter(label => !desiredWorkflow.includes(label)),
  };
}

function toBacklogItem(issue: TrackedIssue): BacklogItem {
  validateBacklogRelations(issue.labels, [String(issue.id), `${issue.platform}:${issue.projectId}#${issue.id}`], true);
  const parentId = issue.labels.find(label => label.startsWith('parent::'))?.slice('parent::'.length);
  const baseBacklogId = issue.labels.find(label => label.startsWith('base::'))?.slice('base::'.length);
  const dependsOn = issue.labels
    .filter(label => label.startsWith('depends-on::') || label.startsWith('depends_on::'))
    .map(label => label.slice(label.indexOf('::') + 2));
  const labeledState = Object.entries(STATE_LABELS).find(([, label]) => issue.labels.includes(label))?.[0] as BacklogState | undefined;
  const state = issue.state === 'closed' || issue.state === 'merged' ? 'done' : labeledState ?? 'ready';
  const executionMode: BacklogExecutionMode = issue.labels.includes(MODE_LABELS.afk) && !issue.labels.includes(MODE_LABELS.hitl) ? 'afk' : 'hitl';
  const executionEligible = (state === 'ready' || state === 'rework') && labeledState !== undefined
    && issue.labels.some(label => Object.values(MODE_LABELS).includes(label as typeof MODE_LABELS[keyof typeof MODE_LABELS]));
  return {
    id: String(issue.id), title: issue.title, description: issue.description, executionEligible,
    parentId, baseBacklogId, dependsOn, state: state ?? 'ready', executionMode, tags: extractBacklogTags(issue.labels),
    ...(labeledState ? { labeledState } : {}),
    branchName: deriveBacklogBranchName(String(issue.id)), providerRef: `${issue.platform}:${issue.projectId}#${issue.id}`,
    webUrl: issue.url,
  };
}
