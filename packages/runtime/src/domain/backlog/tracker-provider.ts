import type { BacklogChangeRequest, BacklogClaim, BacklogCreateInput, BacklogExecutionMode, BacklogItem, BacklogKind, BacklogListOptions, BacklogProvider, BacklogState } from './index.js';
import { FilesystemClaimLock, type ExpiredClaim } from './claim.js';
import {
  NativeOrLockedClaimStrategy,
  type AtomicClaim,
  type AtomicClaimPredicate,
  type ClaimLock,
  type ClaimLockFactory,
} from './claim-strategy.js';
import { BACKLOG_METADATA, backlogMetadataLabelSpecs, type BacklogProviderCapabilities } from './initialization.js';
import { isInternalBacklogLabel, isWorkflowMetadataLabel, validateBusinessTag } from './tags.js';
import { latestOpenRework, parseReworkRecord, renderReworkRecord, type NewReworkRecord, type ReworkRecord, type ReworkResolution } from './rework-record.js';
import type { LabelDelta, TrackerProvider, TrackedIssue } from '../tracker/types.js';
import { canonicalProjectKey, formatWorkItemId, parseWorkItemId, type WorkItemId, type WorkItemScope } from '../work-item/identity.js';
import { planBacklogCreate, renderBacklogDescription, type BacklogCreatePlan } from './creation.js';
import { applyExecutionBaseBranch, parseExecutionBaseBranch } from './execution-base.js';
import { evaluateRunnability, type Runnability } from './runnability.js';
import {
  BACKLOG_RELATION_PREFIX,
  canonicalizeBacklogReference,
  decodeBacklogRelations,
  planRelationLabelDelta,
  planModeLabelDelta,
  planRoleLabelDelta,
  type BacklogMetadataScope,
  type BacklogRelationUpdate,
} from './metadata-codec.js';
import { projectBacklogItem } from './projection.js';
import { findDependencyCycle, type BacklogGraphSource } from './graph.js';

const STATE_LABELS: Record<BacklogState, string> = BACKLOG_METADATA.stateLabels;
const MODE_LABELS: Record<BacklogExecutionMode, string> = BACKLOG_METADATA.executionModeLabels;

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
  /**
   * The canonical project key of the project this adapter reads.
   *
   * The tracker client knows the provider project id, which for GitLab may be
   * a numeric id rather than the project path. The canonical key is derived
   * from the path, so a caller that already resolved the path passes it here.
   */
  projectKey?: string;
  /**
   * Cross-project backlog inventory.
   *
   * A relationship can address an issue in another repository, so "does this
   * item have children?" cannot be answered by the current project alone.
   * Without this source the adapter falls back to a local scan.
   */
  graph?: BacklogGraphSource;
  /** How long a cross-project graph stays usable before it is read again. */
  graphTtlMs?: number;
  /** Reports that the cross-project graph could not be read. */
  onGraphError?: (error: unknown) => void;
}

export class TrackerBacklogProvider implements BacklogProvider {
  readonly capabilities: BacklogProviderCapabilities;
  private readonly atomicClaim?: TrackerBacklogAdapterOptions['atomicClaim'];
  private readonly claimStrategy: NativeOrLockedClaimStrategy;
  private graphCache = new Map<string, { at: number; children: BacklogItem[] }>();

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
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    const changes = await target.tracker.listMRs({ state: 'all' });
    return this.withChangeRequest(toBacklogItem(issue, this.scopeOf(target.tracker)), issue.labels, changes);
  }

  async adopt(id: string): Promise<BacklogItem> {
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    if (issue.state !== 'opened') throw new Error(`backlog ${id} must be open for adoption`);
    const desired = [STATE_LABELS.ready, MODE_LABELS.afk];
    const metadata = issue.labels.filter(isInternalBacklogLabel)
      .map(label => label.replace(/^depends_on::/, 'depends-on::'));
    if (new Set(metadata).size !== metadata.length
      || issue.labels.some(label => isWorkflowMetadataLabel(label) && !desired.includes(label))) {
      throw new Error(`invalid adoption metadata for backlog ${id}: expected ready/afk without duplicate or conflicting AFK labels`);
    }
    try {
      decodeBacklogRelations(metadata, this.scopeOf(target.tracker), {
        strict: true,
        selfId: this.canonicalId(target.tracker, target.issueId),
      });
    } catch (error) {
      throw new Error(`invalid adoption metadata for backlog ${id}: ${(error as Error).message}`);
    }
    const delta = labelDelta(issue.labels, desired, isWorkflowMetadataLabel);
    if (delta.add.length) {
      await this.initialize();
      await this.applyLabelDelta(target.tracker, target.issueId, delta);
    }
    return this.get(id);
  }

  async list(options: BacklogListOptions = {}): Promise<BacklogItem[]> {
    // Read all issues so parent readiness can be derived from every child,
    // including completed children and dependencies.
    const issues = await this.tracker.listIssues({ state: 'all' });
    const changes = await this.tracker.listMRs({ state: 'all' });
    const items = (await Promise.all(issues.map(issue =>
      this.withChangeRequest(toBacklogItem(issue, this.scopeOf(this.tracker)), issue.labels, changes)))).filter(item =>
      (options.state === undefined || item.state === options.state) &&
      (options.kind === undefined || item.kind === options.kind) &&
      (options.executionMode === undefined || item.executionMode === options.executionMode) &&
      (options.parentId === undefined || this.sameReference(item.parentId, options.parentId)) &&
      (options.tag === undefined || item.tags.includes(options.tag)),
    );
    return items;
  }

  /**
   * Plan the creation of one backlog item.
   *
   * The provider owns the project the item is created in, so it resolves the
   * relationship references that name no project. The dry run and the real
   * creation share this plan, so an operator previewed exactly what the
   * provider receives.
   */
  async planCreate(input: BacklogCreateInput): Promise<BacklogCreatePlan> {
    return planBacklogCreate(this, input, this.scopeOf(this.tracker));
  }

  async create(input: BacklogCreateInput): Promise<BacklogItem> {
    const plan = await this.planCreate(input);
    // The dependency targets are resolved before anything is written, so a
    // reference that names nothing cannot leave a record behind.
    const dependencyTargets = plan.dependsOn.map(id => this.resolveTarget(id));
    if (plan.idempotencyLabel) {
      // ponytail: label lookup covers sequential retries; concurrent creators need a distributed lock.
      const existing = (await this.tracker.listIssues({ state: 'all', labels: [plan.idempotencyLabel] }))
        .filter(issue => issue.labels.includes(plan.idempotencyLabel!));
      if (existing.length > 1) throw new Error('idempotency key matches multiple backlog items');
      if (existing.length) {
        const found = await this.get(String(existing[0].id));
        // The record is there; the relation it was created with may not be,
        // so the relation is written now. A run that stops halfway leaves a
        // record without its relation, and a repeated run has to repair it.
        await this.writeDependencyLinks(existing[0].id, dependencyTargets);
        return found;
      }
    }
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
    await this.writeDependencyLinks(id, dependencyTargets);
    const created = await this.get(String(id));
    if (!created.webUrl) return created;
    await this.tracker.updateIssue(id, {
      description: renderBacklogDescription(input.description, { ...plan.links, self: created }),
    });
    return this.get(String(id));
  }

  /** Write the relation that says a record waits for another one. */
  private async writeDependencyLinks(sourceId: number, targets: readonly { tracker: TrackerProvider; issueId: number }[]): Promise<void> {
    for (const target of targets) {
      if (target.tracker === this.tracker) await this.tracker.linkIssues(sourceId, target.issueId, 'blocked_by');
      else await this.tracker.linkIssues(sourceId, target.issueId, 'blocked_by', String(target.tracker.projectId));
    }
  }

  async claim(id: string, owner: string): Promise<BacklogClaim | null> {
    return this.claimStrategy.claim(id, owner);
  }

  async transition(id: string, state: BacklogState, _details?: { reason?: string; changeId?: string }): Promise<void> {
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    const currentMode = issue.labels.find(label => Object.values(MODE_LABELS).includes(label));
    const mode = state === 'blocked' ? MODE_LABELS.hitl : currentMode ?? MODE_LABELS.afk;
    await this.updateWorkflowLabels(target.tracker, target.issueId, issue.labels, [STATE_LABELS[state], mode]);
    if (state === 'done') await target.tracker.updateIssue(target.issueId, { state: 'closed' });
  }

  private async withChangeRequest(item: BacklogItem, labels: readonly string[], changes: Awaited<ReturnType<TrackerProvider['listMRs']>>): Promise<BacklogItem> {
    // A change request that is waiting for a person, and one that is on its
    // way back for another round, both have to be visible: the first is the
    // merge gate, the second is where a conflict went.
    if (!labels.includes(STATE_LABELS.merge_ready)
      && !labels.includes(STATE_LABELS.done)
      && !labels.includes(STATE_LABELS.rework)) return item;
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
        ...(change.mergeState ? { mergeState: change.mergeState } : {}),
      },
    };
  }

  async setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    const currentStage = issue.labels.find(label => Object.values(STATE_LABELS).includes(label));
    if (currentStage) await this.updateWorkflowLabels(target.tracker, target.issueId, issue.labels, [currentStage, MODE_LABELS[mode]]);
    else await target.tracker.updateLabels(target.issueId, labelDelta(issue.labels, [MODE_LABELS[mode]], isModeLabel));
  }

  private async updateWorkflowLabels(tracker: TrackerProvider, issueId: number, current: string[], desired: string[]): Promise<void> {
    await this.applyLabelDelta(tracker, issueId, labelDelta(current, desired, isWorkflowMetadataLabel));
  }

  private async applyLabelDelta(tracker: TrackerProvider, issueId: number, delta: LabelDelta): Promise<void> {
    if (delta.add.length === 0 && delta.remove.length === 0) return;
    await tracker.updateLabels(issueId, delta);
  }

  async createRework(id: string, input: NewReworkRecord): Promise<ReworkRecord> {
    const target = this.resolveTarget(id);
    const comments = await target.tracker.listIssueComments(target.issueId);
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
    await target.tracker.addComment(target.issueId, renderReworkRecord(record));
    if (active) {
      try {
        await target.tracker.updateIssueComment(target.issueId, active.commentId, renderReworkRecord({ ...active.record, status: 'superseded' }));
      } catch (error) {
        await this.supersedeCreatedRework(target.tracker, target.issueId, record).catch(() => {});
        throw error;
      }
    }
    if (input.source === 'operator') {
      await this.transition(id, 'rework');
      await this.setExecutionMode(id, 'afk');
    }
    return record;
  }

  private async supersedeCreatedRework(tracker: TrackerProvider, issueId: number, record: ReworkRecord): Promise<void> {
    const comments = await tracker.listIssueComments(issueId);
    const created = comments
      .map(parseReworkRecord)
      .find(entry => entry?.record.id === record.id && entry.record.status === 'open');
    if (created) {
      await tracker.updateIssueComment(issueId, created.commentId, renderReworkRecord({ ...created.record, status: 'superseded' }));
    }
  }

  async getActiveRework(id: string): Promise<ReworkRecord | undefined> {
    const target = this.resolveTarget(id);
    const comments = await target.tracker.listIssueComments(target.issueId);
    return latestOpenRework(comments)?.record;
  }

  async resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void> {
    const target = this.resolveTarget(id);
    const comments = await target.tracker.listIssueComments(target.issueId);
    const rework = comments
      .map(parseReworkRecord)
      .find((entry): entry is NonNullable<ReturnType<typeof parseReworkRecord>> => entry?.record.id === reworkId && entry.record.status === 'open');
    if (!rework) throw new Error(`open rework record not found: ${reworkId}`);
    const record: ReworkRecord = {
      ...rework.record,
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
      resolutionSummary: resolution.summary,
    };
    await target.tracker.updateIssueComment(target.issueId, rework.commentId, renderReworkRecord(record));
  }

  async addTag(id: string, tag: string): Promise<void> {
    const normalized = validateBusinessTag(tag);
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    if (issue.labels.includes(normalized)) return;
    await target.tracker.updateLabels(target.issueId, { add: [normalized], remove: [] });
  }

  async removeTag(id: string, tag: string): Promise<void> {
    const normalized = validateBusinessTag(tag);
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    if (!issue.labels.includes(normalized)) return;
    await target.tracker.updateLabels(target.issueId, { add: [], remove: [normalized] });
  }

  /**
   * Edit the relationship edges of an item that already exists.
   *
   * A relationship is written when an item is created, but a backlog is alive:
   * a dependency appears when the dependency is discovered, and a baseline
   * edge has to be withdrawn when it turns out to name a branch that does not
   * exist. The codec decides which labels the edit touches, so the write is
   * the smallest delta that carries it — the edge that was replaced is
   * removed, the edge that was asked for is added, and every other label of
   * the issue stays where it is.
   */
  async applyRelationUpdate(id: string, update: BacklogRelationUpdate): Promise<void> {
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    const scope = this.scopeOf(target.tracker);
    const selfId = this.canonicalId(target.tracker, target.issueId);
    const delta = planRelationLabelDelta(issue.labels, update, scope, { selfId });
    const current = decodeBacklogRelations(issue.labels, scope, { strict: false, selfId, allowLegacyBase: true });
    const additions = (update.addDependsOn ?? [])
      .map(reference => canonicalizeBacklogReference(reference, scope))
      .filter(reference => !current.dependsOn.includes(reference));
    const cycle = await findDependencyCycle(selfId, additions, async dependency => {
      const dependencyItem = await this.get(dependency).catch(() => undefined);
      return (dependencyItem?.dependsOn ?? []) as WorkItemId[];
    });
    if (cycle) {
      throw new Error(`invalid backlog relationship: dependency cycle, ${selfId} would wait for ${cycle}`);
    }
    if (delta.add.length === 0 && delta.remove.length === 0) return;
    // A platform only attaches a label that already exists, so a new edge
    // needs its label definition before the edge can be written.
    if (delta.add.length && target.tracker.ensureBacklogMetadata) {
      await target.tracker.ensureBacklogMetadata(delta.add.map(name => ({
        name,
        color: 'C5DEF5',
        description: 'AFK backlog metadata',
      })));
    }
    await target.tracker.updateLabels(target.issueId, { add: delta.add, remove: delta.remove });
  }

  /**
   * Give an item the organizational role of a PRD anchor.
   *
   * The role is written as a label, and the role label is reserved metadata:
   * an anchor carries no stage label at all, and the human-in-the-loop mode
   * says it never runs by itself. Every other label of the issue stays where
   * it is, so an item can become an anchor without losing its children, its
   * dependencies or its business tags.
   */
  async applyRole(id: string, kind: BacklogKind): Promise<void> {
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    const delta = planRoleLabelDelta(issue.labels, kind);
    if (delta.add.length === 0 && delta.remove.length === 0) return;
    if (delta.add.length && target.tracker.ensureBacklogMetadata) {
      await target.tracker.ensureBacklogMetadata(delta.add.map(name => ({
        name,
        color: 'C5DEF5',
        description: 'AFK backlog metadata',
      })));
    }
    await target.tracker.updateLabels(target.issueId, { add: delta.add, remove: delta.remove });
  }

  /**
   * Record the ref the work starts from.
   *
   * The ref belongs in the body of the item. A branch name means nothing
   * outside the repository that has it, so a label would carry a
   * repository-local fact across every repository the credentials reach. The
   * body is where a person writes it down and where AFK reads it back.
   */
  async applyExecutionBase(id: string, baseBranch: string): Promise<void> {
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    const description = issue.description ?? '';
    if (parseExecutionBaseBranch(description) === baseBranch) return;
    await target.tracker.updateIssue(target.issueId, {
      description: applyExecutionBaseBranch(description, baseBranch),
    });
  }

  async applyMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    const target = this.resolveTarget(id);
    const issue = await target.tracker.getIssue(target.issueId);
    const delta = planModeLabelDelta(issue.labels, mode);
    if (delta.add.length === 0 && delta.remove.length === 0) return;
    if (delta.add.length && target.tracker.ensureBacklogMetadata) {
      await target.tracker.ensureBacklogMetadata(delta.add.map(name => ({
        name,
        color: '0052CC',
        description: 'AFK backlog metadata',
      })));
    }
    await target.tracker.updateLabels(target.issueId, { add: delta.add, remove: delta.remove });
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
    return (await this.explainRunnability(item)).runnable;
  }

  /**
   * Whether the item may start now, and what holds it back.
   *
   * The children and the dependencies may live in other repositories, so
   * both are read through the same graph the claim uses: the answer has to
   * agree with the one the claim path reaches.
   */
  async explainRunnability(item: BacklogItem): Promise<Runnability> {
    const children = await this.childrenOf(item);
    const dependencies = await Promise.all(item.dependsOn.map(async dependencyId => {
      const dependency = await this.get(dependencyId).catch(() => null);
      return { id: dependencyId, state: dependency?.state };
    }));
    return evaluateRunnability({
      container: item.kind === 'prd',
      state: item.state,
      executionMode: item.executionMode,
      executionEligible: item.executionEligible,
      hasChildren: children.length > 0,
      dependencies,
    });
  }

  private async isConfirmedClaim(item: BacklogItem): Promise<boolean> {
    if (item.kind === 'prd') return false;
    if (item.state !== 'in_progress' || item.executionMode !== 'afk') return false;
    const children = await this.childrenOf(item);
    if (children.length) return false;
    for (const dependencyId of item.dependsOn) {
      const dependency = await this.get(dependencyId).catch(() => null);
      if (!dependency || dependency.state !== 'done') return false;
    }
    return true;
  }

  /**
   * The children of an item, across every reachable project.
   *
   * A PRD anchor and its implementation children may live in different
   * repositories, so the local scan is only the fallback for a provider that
   * cannot reach the other projects.
   */
  private async childrenOf(item: BacklogItem): Promise<BacklogItem[]> {
    const source = this.options.graph;
    if (!source) return this.list({ parentId: item.id });
    const ttl = this.options.graphTtlMs ?? 30_000;
    const now = Date.now();
    const cached = this.graphCache.get(item.id);
    if (cached && now - cached.at < ttl) return cached.children;
    try {
      const children = await source.childrenOf(item.id);
      this.graphCache.set(item.id, { at: now, children });
      return children;
    } catch (error) {
      this.graphCache.delete(item.id);
      this.options.onGraphError?.(error);
      return this.list({ parentId: item.id });
    }
  }

  private claimKey(id: string): string {
    const target = this.resolveTarget(id);
    return `${target.tracker.platform}/${target.tracker.projectId}/${target.issueId}`;
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

  /** The canonical identity scope of the project a tracker reads. */
  private scopeOf(tracker: TrackerProvider): BacklogMetadataScope {
    const platform = tracker.platform;
    const projectKey = tracker === this.tracker && this.options.projectKey
      ? this.options.projectKey
      : canonicalProjectKey(platform, String(tracker.projectId), tracker.providerHost);
    return { platform, projectKey };
  }

  private canonicalId(tracker: TrackerProvider, issueNumber: number): WorkItemId {
    const scope = this.scopeOf(tracker);
    return formatWorkItemId({ platform: scope.platform, projectKey: scope.projectKey, issueNumber });
  }

  /**
   * Resolve a backlog reference to the tracker and issue that own it.
   *
   * A bare issue number addresses this provider's project. A canonical global
   * identity addresses the project it names, which may be another repository
   * on the same provider host.
   */
  private resolveTarget(id: string): { tracker: TrackerProvider; issueId: number; id: WorkItemId } {
    if (!id.includes(':')) {
      const issueId = this.issueId(id);
      return { tracker: this.tracker, issueId, id: this.canonicalId(this.tracker, issueId) };
    }
    const reference = parseWorkItemId(id);
    if (reference.platform !== this.tracker.platform) throw new Error('cross-platform backlog relationships are not supported');
    if (this.localProjectKeys().includes(reference.projectKey)) {
      return { tracker: this.tracker, issueId: reference.issueNumber, id: reference.id };
    }
    if (!this.tracker.forProject) throw new Error('tracker does not support cross-project backlog relationships');
    const tracker = this.tracker.forProject(reference.projectKey);
    return { tracker, issueId: reference.issueNumber, id: reference.id };
  }

  /** Every spelling of the current project's key that a reference may use. */
  private localProjectKeys(): string[] {
    const projectId = String(this.tracker.projectId);
    const keys = new Set<string>([projectId, this.scopeOf(this.tracker).projectKey]);
    if (this.tracker.providerHost) keys.add(`${this.tracker.providerHost}/${projectId}`);
    return [...keys];
  }

  private issueId(id: string): number {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`tracker backlog id must be a positive integer: ${id}`);
    return value;
  }

  private sameReference(left: string | undefined, right: string): boolean {
    if (left === right) return true;
    if (!left) return false;
    try {
      const leftTarget = this.resolveTarget(left);
      const rightTarget = this.resolveTarget(right);
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

/**
 * Project one provider issue onto the canonical backlog model.
 *
 * The identity is global, so the same issue number in two repositories stays
 * two different backlog items, and every relationship edge names the item it
 * points at unambiguously.
 */
function toBacklogItem(issue: TrackedIssue, scope: BacklogMetadataScope): BacklogItem {
  return projectBacklogItem({
    issueNumber: issue.id,
    title: issue.title,
    description: issue.description,
    labels: issue.labels,
    state: issue.state,
    webUrl: issue.url,
  }, scope);
}