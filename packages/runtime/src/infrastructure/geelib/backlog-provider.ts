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
  type ReworkRevisionInput,
} from '../../domain/backlog/index.js';
import { nextReworkAttempt, reworkRecordId } from '../../domain/backlog/rework-record.js';
import { planReworkRevision } from '../../domain/backlog/rework-revision.js';
import { evaluateRunnability, type Runnability } from '../../domain/backlog/runnability.js';
import { deriveBacklogBranchName } from '../../domain/backlog/index.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import type { ProviderProjectRef } from '../../domain/work-item/types.js';
import type { ListOptions } from '../../domain/tracker/types.js';
import type { BacklogRelationUpdate } from '../../domain/backlog/metadata-codec.js';
import { afkStateForStageTag, afkStateToNative, KIND_PRD_TAG, nativeToAfkState, stageTagFor, STAGE_TAG_NAMES } from './state-map.js';
import {
  GeelibStateMappingResolver,
  loadGeelibStateMappings,
  type GeelibStateMappingEntry,
} from './state-mapping-resolver.js';
import {
  activeRework,
  renderReworkOpenComment,
  renderReworkResolutionComment,
  renderReworkRevisionComment,
  renderReworkSupersededComment,
  reworkHistory,
} from './rework-comments.js';
import type { TrackerIssueComment } from '../../domain/tracker/types.js';

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
  getMatterType(matterId: number): Promise<{ subId: number; typeId: number; typeName: string | undefined }>;
  listProjectTags(): Promise<string[]>;
  listComments(matterId: number, commentType: 'bug' | 'matter' | 'demand'): Promise<Array<{ id: string; body: string; author: string; time: string }>>;
  setStatus(matterId: number, state: string): Promise<void>;
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
  /**
   * The configured per-type, per-project state mappings, injected directly
   * (tests, embedded callers). Wins over `mappingsPath`.
   */
  mappings?: readonly GeelibStateMappingEntry[];
  /**
   * The file to load the state mappings from. Defaults to the standard
   * location, `~/.afk/geelib-state-mappings.yml`; a missing file means no
   * configuration.
   */
  mappingsPath?: string;
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
 *   tags (the platform's OpenAPI cannot create tags) and defaults to afk;
 * - the state names resolve in order: the verified static map, then the
 *   user-configured per-type/project mapping (`state-mapping-resolver.ts`,
 *   `~/.afk/geelib-state-mappings.yml`), then the generic stage — so a type
 *   whose workflow the platform customizes (需求/任务/…) becomes drivable by
 *   configuration, without code changes.
 */
export class GeelibBacklogProvider implements BacklogProvider {
  private readonly claimStrategy: NativeOrLockedClaimStrategy;
  private readonly claimTtlMs: number;
  /** Layer b of the state resolution: the user-configured mappings. */
  private readonly stateMappings: GeelibStateMappingResolver;

  constructor(
    private readonly client: GeelibBacklogClient,
    options: GeelibBacklogProviderOptions = {},
  ) {
    const onExpiredClaim = options.onExpiredClaim ?? (async () => true);
    const claimLock: ClaimLock = options.claimLock
      ?? options.claimLockFactory?.(onExpiredClaim)
      ?? new FilesystemClaimLock(options.stateRoot);
    this.claimTtlMs = options.claimTtlMs ?? 60 * 60_000;
    this.stateMappings = options.mappings
      ? new GeelibStateMappingResolver(options.mappings)
      : loadGeelibStateMappings(options.mappingsPath);
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
    const parsed = parseWorkItemId(this.canonicalId(id));
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
      items.push(await this.toBacklogItem(String(this.client.projectId), issue, state));
    }
    return items.filter(item => options.state === undefined || item.state === options.state);
  }

  async claim(id: string, owner: string): Promise<BacklogClaim | null> {
    // Fail fast, before the lease: a project without the stage tags cannot
    // carry AFK's lifecycle, and every later transition would fail anyway.
    await this.ensureStageVocabulary(id);
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

  private async ensureStageVocabulary(id: string): Promise<void> {
    const parsed = parseWorkItemId(this.canonicalId(id));
    const projectTags = await this.client.listProjectTags();
    const missing = STAGE_TAG_NAMES.filter(tag => !projectTags.includes(tag));
    if (missing.length) {
      throw new Error(`geelib project ${parsed.projectKey} is missing the AFK state tags: ${missing.join(', ')}; provision them once in the platform UI (the OpenAPI cannot create tags).`);
    }
  }

  async transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void> {
    const parsed = parseWorkItemId(this.canonicalId(id));

    // 1. The authoritative move: swap the stage tags. The platform's native
    //    state machine is customized per type, so AFK's lifecycle lives here.
    const issue = await this.client.getIssue(parsed.issueNumber);
    const targetTag = stageTagFor(state);
    if (!issue.labels.includes(targetTag)) {
      const labels = issue.labels.filter(label => !label.startsWith('stage::'));
      labels.push(targetTag);
      await this.client.setLabels(parsed.issueNumber, labels);
      // The platform silently drops a label the project does not have; the
      // tag is the AFK truth, so a dropped write fails the transition.
      const confirmed = await this.client.getIssue(parsed.issueNumber);
      if (!confirmed.labels.includes(targetTag)) {
        throw new Error(`The platform dropped ${targetTag}: pre-provision the stage:: tags on the project once, in the platform UI.`);
      }
    }

    // 2. Best-effort: move the native status alongside, as the human-facing
    //    approximation. The static name first; only when the item's type
    //    does not define it does the configured mapping supply the type's
    //    own name. A native refusal (a type whose machine lacks the target)
    //    must not fail the AFK transition — the tag already carries it.
    try {
      const staticTarget = afkStateToNative(state);
      const { name: current } = await this.client.getMatterState(parsed.issueNumber);
      if (current !== staticTarget) {
        const defined = await this.client.getMatterNativeStates(parsed.issueNumber);
        let target: string = staticTarget;
        let viaMapping = false;
        if (!defined.includes(staticTarget) && !this.stateMappings.isEmpty) {
          const configured = this.stateMappings.nativeStateFor(await this.client.getMatterType(parsed.issueNumber), state);
          if (configured) {
            target = configured;
            viaMapping = true;
          }
        }
        if (current !== target && defined.includes(target)) {
          await this.client.setStatus(parsed.issueNumber, target);
        }
        void viaMapping;
      }
    } catch {
      // Non-fatal by design (confirmed with the product decision): the tag
      // carries the state; a stale native status is a UI display gap.
    }

    // 3. The comment a transition leaves when the status cannot say it all.
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
    const parsed = parseWorkItemId(this.canonicalId(id));
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

  /**
   * The comments of an item, read from the silo AFK writes to.
   *
   * The silo question matters: the platform keeps bug/matter/demand comment
   * silos isolated, so a reader must name the same type the writer used.
   * AFK writes `matter`; pass a different silo to read what the UI panel
   * shows once its type is confirmed.
   */
  async listIssueComments(id: string, commentType: 'bug' | 'matter' | 'demand' = 'matter'): Promise<TrackerIssueComment[]> {
    const parsed = parseWorkItemId(this.canonicalId(id));
    const comments = await this.client.listComments(parsed.issueNumber, commentType);
    return comments.map(comment => ({ id: comment.id, body: comment.body }));
  }

  async addComment(id: string, html: string): Promise<void> {
    const parsed = parseWorkItemId(this.canonicalId(id));
    await this.client.addComment(parsed.issueNumber, html);
  }

  /**
   * The canonical identity a caller-supplied item reference names.
   *
   * The managed execution request addresses an item by its provider-local
   * issue number (the manifest's `providerBacklogId`), and the local tracker
   * index hands out the same form. A bare number is therefore resolved
   * inside the project this client serves; anything else must already be
   * canonical.
   */
  private canonicalId(id: string): string {
    const bare = id.trim();
    return /^\d+$/.test(bare) ? `geelib:${this.client.projectId}#${bare}` : id;
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

  private async toBacklogItem(projectKey: string, issue: { id: number; title: string; description: string; labels: string[]; state: 'opened' | 'closed' | 'merged'; url: string }, state: { name: string | undefined; stage: string | undefined }, workItemId?: BacklogItem['workItemId'], dependsOn: string[] = []): Promise<BacklogItem> {
    const id = workItemId ?? `geelib:${projectKey}#${issue.id}`;
    const modeLabel = issue.labels.find(label => label === 'mode::afk' || label === 'mode::hitl');
    // Resolution order, top to bottom: the stage tag (AFK's authoritative
    // lifecycle, carried per decision to use the tag channel) → the verified
    // static map → the configured mapping for this project+type → the
    // generic stage fallback. The tag exists on everything AFK has touched.
    const stageTag = issue.labels.find(label => afkStateForStageTag(label) !== undefined);
    const tagState = stageTag ? afkStateForStageTag(stageTag) : undefined;
    const resolved = tagState
      ? { state: tagState, labeledState: tagState }
      : await this.resolveAfkState(issue.id, state, issue.state);
    return {
      id,
      workItemId,
      issueNumber: issue.id,
      project: { platform: 'geelib', projectKey, name: projectKey },
      managed: true,
      // The tag channel drives any type once the stage tags are provisioned;
      // the claim pre-flight is what verifies that, per item claim.
      executionEligible: true,
      state: resolved.state,
      labeledState: resolved.labeledState,
      kind: issue.labels.includes(KIND_PRD_TAG) ? 'prd' : undefined,
      executionMode: modeLabel === 'mode::hitl' ? 'hitl' : 'afk',
      title: issue.title,
      description: issue.description || undefined,
      dependsOn,
      tags: issue.labels.filter(label => !RESERVED_LABEL_PREFIXES.some(prefix => label.startsWith(prefix))),
      // Hybrid mode: the item's branches and change requests live on the git
      // platform, so the association scope (`<branch>`/`<branch>-qa`) must
      // name the branch AFK actually works on — the same derivation the
      // inventory projection and the run request use.
      branchName: deriveBacklogBranchName(String(issue.id)),
      providerRef: id,
      webUrl: issue.url,
    };
  }

  /**
   * The AFK state of an item, resolved in the documented order: (a) the
   * verified static map, (b) the configured mapping for this project+type,
   * (c) the generic stage fallback. The configuration layer is consulted
   * only when the static map misses, so an unconfigured or 缺陷-typed item
   * costs no extra platform call.
   */
  private async resolveAfkState(matterId: number, state: { name: string | undefined; stage: string | undefined }, issueState: 'opened' | 'closed' | 'merged'): Promise<{ state: BacklogState; labeledState: BacklogState | undefined }> {
    const name = state.name ?? '';
    const staticMapped = nativeToAfkState(name);
    if (staticMapped) return { state: staticMapped, labeledState: staticMapped };
    if (!this.stateMappings.isEmpty) {
      const configured = this.stateMappings.afkStateFor(await this.client.getMatterType(matterId), name);
      if (configured) return { state: configured, labeledState: configured };
    }
    switch (state.stage) {
      case '未开始': return { state: 'ready', labeledState: undefined };
      case '进行中': return { state: 'in_progress', labeledState: undefined };
      case '已完成':
      case '已关闭': return { state: 'done', labeledState: undefined };
      default: return { state: issueState === 'closed' ? 'done' : 'ready', labeledState: undefined };
    }
  }

  private claimKey(id: string): string {
    const parsed = parseWorkItemId(this.canonicalId(id));
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
  /**
   * Mark an item as a PRD anchor through the kind tag.
   *
   * The tag channel makes geelib items usable as organizational parents:
   * the anchor itself is a container (never executable) and its children
   * are the work the schedule dispatches.
   */
  async applyRole(id: string, kind: BacklogKind): Promise<void> {
    if (kind !== 'prd') throw new Error(`the geelib provider only carries the prd role (as the ${KIND_PRD_TAG} tag)`);
    const parsed = parseWorkItemId(this.canonicalId(id));
    const issue = await this.client.getIssue(parsed.issueNumber);
    if (issue.labels.includes(KIND_PRD_TAG)) return;
    await this.client.setLabels(parsed.issueNumber, [...issue.labels, KIND_PRD_TAG]);
    // The platform silently drops a label the project does not have.
    const confirmed = await this.client.getIssue(parsed.issueNumber);
    if (!confirmed.labels.includes(KIND_PRD_TAG)) {
      throw new Error(`The platform dropped ${KIND_PRD_TAG}: pre-provision it on the project once, in the platform UI.`);
    }
  }
  applyExecutionBase = this.refused('recording the execution base');
  applyPrdBaseline = this.refused('recording the PRD baseline');
  applyDescription = this.refused('replacing the body');
  async applyMode(id: string, mode: BacklogExecutionMode): Promise<void> {
    const parsed = parseWorkItemId(this.canonicalId(id));
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

  /**
   * Open one rework record, written as a comment.
   *
   * The QA and merge-conflict paths route the item's state themselves —
   * `routeQARework`/`openConflictRework` call `transition('rework', …)` right
   * after this returns — so this writes the record comment only. The
   * operator-retry path (`retryBacklog`) has no transition of its own and
   * relies on the provider to move the item out of blocked+hitl, exactly as
   * the git providers do, so the operator source transitions here.
   *
   * The platform's comments are append-only, so a record that is still open
   * when the next one is written is closed by an appended superseded marker
   * rather than edited; the newest open record is the active one.
   */
  async createRework(id: string, input: NewReworkRecord): Promise<ReworkRecord> {
    const matterId = this.matterIdOf(id);
    const history = await this.client.listComments(matterId, 'matter').then(reworkHistory);
    const open = history.filter(record => record.status === 'open');
    const active = open.length ? open[open.length - 1] : undefined;
    if (active?.source === 'operator' && input.source === 'operator') {
      throw new Error(`backlog ${id} already has an open rework record`);
    }
    const { cycle, attempt } = nextReworkAttempt(history, input.source);
    const record: ReworkRecord = {
      ...input,
      version: 1,
      id: reworkRecordId(cycle, attempt),
      cycle,
      attempt,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    await this.client.addComment(matterId, renderReworkOpenComment(record));
    if (active) await this.client.addComment(matterId, renderReworkSupersededComment(active.id));
    if (input.source === 'operator') {
      await this.transition(id, 'rework');
      await this.setExecutionMode(id, 'afk');
    }
    return record;
  }

  async getActiveRework(id: string): Promise<ReworkRecord | undefined> {
    const matterId = this.matterIdOf(id);
    const comments = await this.client.listComments(matterId, 'matter');
    return activeRework(comments);
  }

  async resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void> {
    const matterId = this.matterIdOf(id);
    const record = await this.openRecord(matterId, reworkId);
    const resolved = { resolvedAt: new Date().toISOString(), summary: resolution.summary };
    await this.client.addComment(matterId, renderReworkResolutionComment(record.id, resolved));
  }

  /**
   * Correct an open rework record to the current fact.
   *
   * The record itself cannot be edited on this platform, so the correction
   * is an appended revision comment; reading folds it back onto the record
   * it corrects. The record keeps its identity, its round and its evidence —
   * only the statement about the current situation moves, and the previous
   * statement stays in the trail.
   */
  async reviseRework(id: string, reworkId: string, revision: ReworkRevisionInput): Promise<ReworkRecord> {
    const matterId = this.matterIdOf(id);
    const record = await this.openRecord(matterId, reworkId);
    const revised = planReworkRevision(record, revision);
    const entry = revised.revisions?.[revised.revisions.length - 1];
    if (!entry) throw new Error(`the rework revision produced no correction: ${reworkId}`);
    await this.client.addComment(matterId, renderReworkRevisionComment(record.id, entry));
    return revised;
  }

  /** The open record an id names, or the refusal the git providers raise. */
  private async openRecord(matterId: number, reworkId: string): Promise<ReworkRecord> {
    const comments = await this.client.listComments(matterId, 'matter');
    const record = reworkHistory(comments).find(candidate => candidate.id === reworkId && candidate.status === 'open');
    if (!record) throw new Error(`open rework record not found: ${reworkId}`);
    return record;
  }

  /** The numeric matter id a work-item reference names inside this project. */
  private matterIdOf(id: string): number {
    return parseWorkItemId(this.canonicalId(id)).issueNumber;
  }

  async initialize(): Promise<void> {
    // The native state machine needs no provisioning.
  }
}
