import { FilesystemClaimLock, type ClaimLease } from '../../domain/backlog/claim.js';
import type { ClaimLock, ClaimLockFactory } from '../../domain/backlog/claim-strategy.js';
import { NativeOrLockedClaimStrategy } from '../../domain/backlog/claim-strategy.js';
import {
  type BacklogClaim,
  type BacklogCreateInput,
  type BacklogCreatePlan,
  type BacklogItem,
  type BacklogKind,
  type BacklogListOptions,
  type BacklogProvider,
  type BacklogState,
  type BacklogExecutionMode,
  type NewReworkRecord,
  type ReworkRecord,
  type ReworkResolution,
} from '../../domain/backlog/index.js';
import { evaluateRunnability, type Runnability } from '../../domain/backlog/runnability.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import type { ProviderProjectRef } from '../../domain/work-item/types.js';
import type { ListOptions } from '../../domain/tracker/types.js';
import type { BacklogRelationUpdate } from '../../domain/backlog/metadata-codec.js';
import { afkStateToNative, nativeToAfkState } from './state-map.js';

/**
 * The slice of the geelib client the backlog provider drives. `GeelibClient`
 * satisfies it structurally; tests inject the real client over a mocked
 * platform or a fake.
 */
export interface GeelibBacklogClient {
  readonly platform: 'geelib';
  readonly projectId: string | number;
  readonly providerHost: string;
  getIssue(id: number): Promise<{ id: number; title: string; description: string; labels: string[]; state: 'opened' | 'closed' | 'merged'; url: string }>;
  listIssues(options?: ListOptions): Promise<Array<{ id: number; title: string; description: string; labels: string[]; state: 'opened' | 'closed' | 'merged'; url: string }>>;
  getMatterStateName(matterId: number): Promise<string | undefined>;
  getMatterState(matterId: number): Promise<{ name: string | undefined; stage: string | undefined }>;
  getMatterNativeStates(matterId: number): Promise<string[]>;
  setStatus(matterId: number, state: import('./state-map.js').NativeStateName): Promise<void>;
  setLabels(matterId: number, labels: readonly string[]): Promise<void>;
  addComment(matterId: number, html: string): Promise<void>;
  changeParent(matterId: number, parentId: number): Promise<void>;
  addResourceReferences(matterId: number, targets: ReadonlyArray<{ id: number; title: string; subId: number }>): Promise<void>;
  listResourceReferences(matterId: number): Promise<Array<{ referenceId: number; id: number; title: string; subId: number }>>;
}

export interface GeelibBacklogProviderOptions {
  claimLock?: ClaimLock;
  claimLockFactory?: ClaimLockFactory;
  claimTtlMs?: number;
  /** Trusted local storage root for the default file lease. */
  stateRoot?: string;
  /** Decides whether an expired claim on the lease may be taken over. */
  onExpiredClaim?: (key: string) => Promise<boolean>;
}

const RESERVED_LABEL_PREFIXES = ['mode::', 'stage::', 'kind::', 'idempotency::', 'depends-on::', 'parent::', 'ac::'];

/** The platform comments are HTML rich text; runner text must not smuggle markup in. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The geelib backlog provider: AFK's lifecycle, written onto the platform's
 * native state machine.
 *
 * Mapping decisions (verified live, see `state-map.ts`):
 * - the native status carries the lifecycle, so every item this provider
 *   serves is managed — the operator pointed AFK at the project;
 * - `merge_ready` and `done` collapse onto 已验证, because 关闭 is not
 *   reachable through the API; the done confirmation travels as a comment
 *   written by the reconciliation step;
 * - the execution mode rides on the pre-provisioned `mode::afk`/`mode::hitl`
 *   tags (the platform's OpenAPI cannot create tags) and defaults to afk.
 */
export class GeelibBacklogProvider implements BacklogProvider {
  private readonly claimStrategy: NativeOrLockedClaimStrategy;
  private readonly claimTtlMs: number;

  constructor(
    private readonly client: GeelibBacklogClient,
    options: GeelibBacklogProviderOptions = {},
  ) {
    const onExpiredClaim = options.onExpiredClaim ?? (async () => true);
    const claimLock: ClaimLock = options.claimLock
      ?? options.claimLockFactory?.(onExpiredClaim)
      ?? new FilesystemClaimLock(options.stateRoot);
    this.claimTtlMs = options.claimTtlMs ?? 60 * 60_000;
    this.claimStrategy = new NativeOrLockedClaimStrategy({
      claimLock,
      claimKey: id => this.claimKey(id),
      claimTtlMs: this.claimTtlMs,
      read: id => this.get(id),
      isRunnable: async item => this.runnabilityOf(item).runnable,
      transitionToInProgress: id => this.transition(id, 'in_progress'),
      isConfirmedClaim: async item => item.state === 'in_progress' && item.executionMode === 'afk',
      blockAndRouteToHitl: async id => {
        await this.transition(id, 'blocked');
        return true;
      },
    });
  }

  async get(id: string): Promise<BacklogItem> {
    const parsed = parseWorkItemId(id);
    if (parsed.platform !== 'geelib') throw new Error(`the geelib provider serves geelib work items only: ${id}`);
    if (String(this.client.projectId) !== parsed.projectKey) {
      throw new Error(`work item ${id} does not belong to geelib project ${this.client.projectId}`);
    }
    const issue = await this.client.getIssue(parsed.issueNumber);
    const state = await this.client.getMatterState(parsed.issueNumber);
    const dependsOn = await this.client.listResourceReferences(parsed.issueNumber)
      .then(references => references.map(reference => `geelib:${reference.subId}#${reference.id}`))
      .catch(() => [] as string[]);
    return this.toBacklogItem(parsed.projectKey, issue, state, parsed.id as BacklogItem['workItemId'], dependsOn);
  }

  async list(options: BacklogListOptions = {}): Promise<BacklogItem[]> {
    const issues = await this.client.listIssues({ state: 'all' });
    const items: BacklogItem[] = [];
    for (const issue of issues) {
      const state = await this.client.getMatterState(issue.id);
      items.push(this.toBacklogItem(String(this.client.projectId), issue, state));
    }
    return items.filter(item => options.state === undefined || item.state === options.state);
  }

  async claim(id: string, owner: string): Promise<BacklogClaim | null> {
    const claim = await this.claimStrategy.claim(id, owner);
    if (!claim) return null;
    return {
      ...claim,
      heartbeat: async () => {
        const item = await this.get(id);
        if (item.state !== 'in_progress' || item.executionMode !== 'afk') {
          await claim.release();
          throw new Error(`claim for ${id} was interrupted`);
        }
        await claim.heartbeat();
      },
    };
  }

  async transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void> {
    const parsed = parseWorkItemId(id);
    const target = afkStateToNative(state);
    const { name: current } = await this.client.getMatterState(parsed.issueNumber);
    if (current !== target) {
      // The platform customizes status names per type: a 缺陷 name like 修复中
      // does not exist in the 需求 workflow. Refuse before the call instead of
      // surfacing a generic platform 5001.
      const defined = await this.client.getMatterNativeStates(parsed.issueNumber);
      if (!defined.includes(target)) {
        throw new Error(`This work item's type does not define native state ${target}; AFK drives the 缺陷 workflow names only. Current type defines: ${defined.join('、') || '(none)'}`);
      }
      await this.client.setStatus(parsed.issueNumber, target);
    }
    const note = this.reconciliationNote(state, details);
    if (note) await this.client.addComment(parsed.issueNumber, note);
  }

  /**
   * The comment a transition leaves on the platform, when it has something
   * the status field cannot say.
   *
   * The native state carries the lifecycle position, so a bare transition
   * is silent. What the status cannot carry is the why and the what's-next:
   * a blocked or rework reason from the runner, the change request an item
   * now waits on, and — because `done` collapses onto the same native state
   * as `merge_ready` — the merge confirmation that makes an item done.
   */
  private reconciliationNote(state: BacklogState, details?: { reason?: string; changeId?: string }): string | undefined {
    if (state === 'done') {
      const confirmation = details?.changeId ? `变更 #${details.changeId} 已合并并确认` : '变更已合并并确认';
      return `<p><strong>AFK 已完成</strong>：${confirmation}。</p>`;
    }
    if (details?.reason && (state === 'blocked' || state === 'rework')) {
      return `<p><strong>AFK ${state === 'blocked' ? '阻塞' : '返工'}</strong>：${escapeHtml(details.reason)}</p>`;
    }
    if (details?.changeId && state === 'merge_ready') {
      return `<p><strong>AFK 待合并</strong>：变更请求 #${escapeHtml(details.changeId)} 已发布，等待人工合并。</p>`;
    }
    return undefined;
  }

  /**
   * Apply a relationship edit through the platform's two channels: the
   * native parent edge and the resource-reference dependency edges.
   *
   * Cross-platform references are refused — the reference module links
   * geelib work items only, which the work-identity contract already
   * treats as the rule. Edge removal rides on the platform's deletion
   * endpoint, which refuses every id form (see the client); an operator
   * removes edges on the platform UI.
   */
  async applyRelationUpdate(id: string, update: BacklogRelationUpdate): Promise<void> {
    const parsed = parseWorkItemId(id);
    if (update.clearParent) throw new Error('The geelib provider cannot clear a parent edge: the platform exposes no parent-removal call.');
    if (update.removeDependsOn?.length) {
      throw new Error('The geelib provider cannot delete resource references: the platform deletion API refuses every id form (its own CLI fails identically); remove them on the platform UI.');
    }
    if (update.parent) {
      const parent = this.resolveLocalReference(update.parent, id);
      await this.client.changeParent(parsed.issueNumber, parent);
    }
    if (update.base || update.clearBase) {
      throw new Error('The geelib provider cannot carry an execution-base edge; baselines live on the git platform.');
    }
    for (const reference of update.addDependsOn ?? []) {
      const target = this.resolveLocalReference(reference, id);
      const targetIssue = await this.client.getIssue(target);
      await this.client.addResourceReferences(parsed.issueNumber, [{
        id: target,
        title: targetIssue.title,
        subId: Number(this.client.projectId),
      }]);
    }
  }

  /** Resolve a geelib reference to the numeric matter id it names. */
  private resolveLocalReference(reference: string, context: string): number {
    const parsed = parseWorkItemId(reference);
    if (parsed.platform !== 'geelib') {
      throw new Error(`cross-platform relationships are not supported: ${reference} (from ${context})`);
    }
    return parsed.issueNumber;
  }

  isRunnable(item: BacklogItem): Promise<boolean> {
    return Promise.resolve(this.runnabilityOf(item).runnable);
  }

  async explainRunnability(item: BacklogItem): Promise<Runnability> {
    return this.runnabilityOf(item);
  }

  async addComment(id: string, html: string): Promise<void> {
    const parsed = parseWorkItemId(id);
    await this.client.addComment(parsed.issueNumber, html);
  }

  private runnabilityOf(item: BacklogItem): Runnability {
    return evaluateRunnability({
      container: item.kind === 'prd',
      state: item.state,
      executionMode: item.executionMode,
      executionEligible: Boolean(item.managed && item.executionEligible),
      hasChildren: false,
      dependencies: item.dependsOn.map(dependencyId => ({ id: dependencyId, state: undefined })),
    });
  }

  private toBacklogItem(projectKey: string, issue: { id: number; title: string; description: string; labels: string[]; state: 'opened' | 'closed' | 'merged'; url: string }, state: { name: string | undefined; stage: string | undefined }, workItemId?: BacklogItem['workItemId'], dependsOn: string[] = []): BacklogItem {
    const id = workItemId ?? `geelib:${projectKey}#${issue.id}`;
    const modeLabel = issue.labels.find(label => label === 'mode::afk' || label === 'mode::hitl');
    return {
      id,
      workItemId,
      issueNumber: issue.id,
      project: { platform: 'geelib', projectKey, name: projectKey },
      managed: true,
      executionEligible: true,
      // Known native names map through the verified table; a type-customized
      // name falls back to the platform's generic stage, which is the one
      // dimension consistent across types — it never misreads in-progress
      // work as claimable.
      state: this.afkStateOf(state, issue.state),
      labeledState: nativeToAfkState(state.name ?? ''),
      executionMode: modeLabel === 'mode::hitl' ? 'hitl' : 'afk',
      title: issue.title,
      description: issue.description || undefined,
      dependsOn,
      tags: issue.labels.filter(label => !RESERVED_LABEL_PREFIXES.some(prefix => label.startsWith(prefix))),
      branchName: '',
      providerRef: id,
      webUrl: issue.url,
    };
  }

  /** Known name → verified mapping; otherwise the generic stage is the fallback. */
  private afkStateOf(state: { name: string | undefined; stage: string | undefined }, issueState: 'opened' | 'closed' | 'merged'): BacklogState {
    const mapped = nativeToAfkState(state.name ?? '');
    if (mapped) return mapped;
    switch (state.stage) {
      case '未开始': return 'ready';
      case '进行中': return 'in_progress';
      case '已完成':
      case '已关闭': return 'done';
      default: return issueState === 'closed' ? 'done' : 'ready';
    }
  }

  private claimKey(id: string): string {
    const parsed = parseWorkItemId(id);
    return `geelib/${parsed.projectKey}/${parsed.issueNumber}`;
  }

  private projectRef(projectKey: string): ProviderProjectRef {
    return { platform: 'geelib', projectKey, name: projectKey };
  }

  // ── Refused until their slice ───────────────────────────────────────────
  //
  // Creation, business-tag edits and the relation channel each carry a
  // design decision (the platform cannot create tags; relations ride on the
  // resource-reference module), so they refuse instead of half-working.

  private refused(operation: string): () => Promise<never> {
    return async () => {
      throw new Error(`The geelib backlog provider does not support ${operation} yet; it lands in a later slice.`);
    };
  }

  planCreate = this.refused('creating work items; create them on the platform');
  create = this.refused('creating work items; create them on the platform');
  addTag = this.refused('editing tags; the platform cannot create tags through its API');
  removeTag = this.refused('editing tags; the platform cannot create tags through its API');
  applyRole = this.refused('assigning the PRD role');
  applyExecutionBase = this.refused('recording the execution base');
  applyPrdBaseline = this.refused('recording the PRD baseline');
  applyDescription = this.refused('replacing the body');
  async applyMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    const parsed = parseWorkItemId(id);
    const target = `mode::${mode}`;
    const issue = await this.client.getIssue(parsed.issueNumber);
    const labels = issue.labels.filter(label => label !== 'mode::afk' && label !== 'mode::hitl');
    if (!labels.includes(target)) labels.push(target);
    await this.client.setLabels(parsed.issueNumber, labels);
    // The platform silently drops a label the project does not have, so the
    // write is verified: a mode tag that did not land means the project was
    // not provisioned, and the switch has not happened.
    const confirmed = await this.client.getIssue(parsed.issueNumber);
    if (!confirmed.labels.includes(target)) {
      throw new Error(`The platform dropped ${target}: pre-provision the mode::afk/mode::hitl tags on the project once, in the platform UI.`);
    }
  }

  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    return this.applyMode(id, mode);
  }
  createRework = this.refused('rework records; rework rides on the native rework state in this slice');
  getActiveRework = this.refused('rework records');
  resolveRework = this.refused('rework records');
  reviseRework = this.refused('rework records');
  async initialize(): Promise<void> {
    // The native state machine needs no provisioning.
  }
}
