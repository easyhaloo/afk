import type { BacklogClaim, BacklogCreateInput, BacklogExecutionMode, BacklogItem, BacklogProvider, BacklogState } from './index';
import { deriveBacklogBranchName } from './index';
import { FilesystemClaimLock, type ExpiredClaim } from './claim';
import {
  NativeOrLockedClaimStrategy,
  type AtomicClaim,
  type AtomicClaimPredicate,
  type ClaimLock,
  type ClaimLockFactory,
} from './claim-strategy';
import { BACKLOG_METADATA, type BacklogProviderCapabilities } from './initialization';
import { extractBacklogTags, isWorkflowMetadataLabel, validateBusinessTag } from './tags';
import { latestOpenRework, parseReworkRecord, renderReworkRecord, type NewReworkRecord, type ReworkRecord, type ReworkResolution } from './rework-record';
import type { LabelDelta, TrackerProvider, TrackedIssue } from '../tracker/types';

const STATE_LABELS: Record<BacklogState, string> = BACKLOG_METADATA.stateLabels;
const MODE_LABELS = BACKLOG_METADATA.executionModeLabels;

export type { AtomicClaimPredicate } from './claim-strategy';

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
    const issue = await this.tracker.getIssue(this.issueId(id));
    return toBacklogItem(issue);
  }

  async list(options: { state?: BacklogState; executionMode?: BacklogExecutionMode; parentId?: string; tag?: string } = {}): Promise<BacklogItem[]> {
    // Read all issues so parent readiness can be derived from every child,
    // including completed children and dependencies.
    const issues = await this.tracker.listIssues({ state: 'all' });
    const items = issues.map(toBacklogItem).filter(item =>
      (options.state === undefined || item.state === options.state) &&
      (options.executionMode === undefined || item.executionMode === options.executionMode) &&
      (options.parentId === undefined || item.parentId === options.parentId) &&
      (options.tag === undefined || item.tags.includes(options.tag)),
    );
    return items;
  }

  async create(input: BacklogCreateInput): Promise<BacklogItem> {
    const title = input.title.trim();
    if (!title) throw new Error('backlog title must not be empty');
    const parentId = input.parentId && this.canonicalId(input.parentId);
    const dependsOn = [...new Set((input.dependsOn ?? []).map(id => this.canonicalId(id)))];
    const mode = input.executionMode ?? 'afk';
    const tags = [...new Set((input.tags ?? []).map(validateBusinessTag))];
    const linkedItems = await Promise.all([
      ...(parentId ? [this.get(parentId)] : []),
      ...dependsOn.map(id => this.get(id)),
    ]);
    const parent = parentId ? linkedItems[0] : undefined;
    const dependencies = linkedItems.slice(parent ? 1 : 0);
    const labels = [
      BACKLOG_METADATA.stateLabels.ready,
      MODE_LABELS[mode],
      ...tags,
      ...(parentId ? [`parent::${parentId}`] : []),
      ...dependsOn.map(id => `depends-on::${id}`),
    ];
    const id = await this.tracker.createIssue({
      title,
      description: renderBacklogDescription(input.description, { parent, dependencies }),
      labels,
    });
    for (const dependencyId of dependsOn) {
      await this.tracker.linkIssues(id, this.issueId(dependencyId), 'blocked_by');
    }
    const created = await this.get(String(id));
    if (!created.webUrl) return created;
    await this.tracker.updateIssue(id, {
      description: renderBacklogDescription(input.description, { parent, dependencies, self: created }),
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
    if (latestOpenRework(comments)) throw new Error(`backlog ${id} already has an open rework record`);
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
    await this.transition(id, 'rework');
    await this.setExecutionMode(id, 'afk');
    return record;
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
    // Trackers create labels lazily when an issue is updated.  Validate access
    // and let a platform adapter provision metadata when it supports it.
    const options = this.options;
    if (options.ensureMetadata) {
      await options.ensureMetadata(BACKLOG_METADATA);
      return;
    }
    await this.tracker.listIssues({ state: 'all', perPage: 1 });
  }

  async isRunnable(item: BacklogItem): Promise<boolean> {
    if ((item.state !== 'ready' && item.state !== 'rework') || item.executionMode !== 'afk') return false;
    const children = await this.list({ parentId: item.id });
    if (children.some(child => child.state !== 'done')) return false;
    for (const dependencyId of item.dependsOn) {
      const dependency = await this.get(dependencyId).catch(() => null);
      if (!dependency || dependency.state !== 'done') return false;
    }
    return true;
  }

  private async isConfirmedClaim(item: BacklogItem): Promise<boolean> {
    if (item.state !== 'in_progress' || item.executionMode !== 'afk') return false;
    const children = await this.list({ parentId: item.id });
    if (children.some(child => child.state !== 'done')) return false;
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

  private canonicalId(id: string): string {
    const issueId = this.issueId(id.trim());
    return String(issueId);
  }

  private readonly options: TrackerBacklogAdapterOptions;
}

function renderBacklogDescription(
  description: string,
  links: { parent?: BacklogItem; dependencies: BacklogItem[]; self?: BacklogItem },
): string {
  const entries = [
    ...(links.self?.webUrl ? [`- This backlog: [#${links.self.id}](${links.self.webUrl})`] : []),
    ...(links.parent?.webUrl ? [`- Parent backlog: [#${links.parent.id}](${links.parent.webUrl})`] : []),
    ...links.dependencies.flatMap(item => item.webUrl ? [`- Depends on: [#${item.id}](${item.webUrl})`] : []),
  ];
  if (entries.length === 0) return description;
  return `${description.trimEnd()}\n\n## Backlog Links\n\n${entries.join('\n')}\n`;
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
  const parentId = issue.labels.find(label => /^parent::[^:]+$/.test(label))?.slice('parent::'.length);
  const dependsOn = issue.labels
    .filter(label => /^depends-on::[^:]+$/.test(label) || /^depends_on::[^:]+$/.test(label))
    .map(label => label.split('::')[1]);
  const labeledState = Object.entries(STATE_LABELS).find(([, label]) => issue.labels.includes(label))?.[0] as BacklogState | undefined;
  const state = labeledState ?? (issue.state === 'closed' || issue.state === 'merged' ? 'done' : 'ready');
  const executionMode: BacklogExecutionMode = issue.labels.includes(MODE_LABELS.hitl) ? 'hitl' : 'afk';
  return {
    id: String(issue.id), title: issue.title, description: issue.description,
    parentId, dependsOn, state: state ?? 'ready', executionMode, tags: extractBacklogTags(issue.labels),
    branchName: deriveBacklogBranchName(String(issue.id)), providerRef: `${issue.platform}:${issue.projectId}#${issue.id}`,
    webUrl: issue.url,
  };
}
