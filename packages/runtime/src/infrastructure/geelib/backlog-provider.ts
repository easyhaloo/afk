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
  setStatus(matterId: number, state: import('./state-map.js').NativeStateName): Promise<void>;
  addComment(matterId: number, html: string): Promise<void>;
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
    const stateName = await this.client.getMatterStateName(parsed.issueNumber);
    return this.toBacklogItem(parsed.projectKey, issue, stateName, parsed.id as BacklogItem['workItemId']);
  }

  async list(options: BacklogListOptions = {}): Promise<BacklogItem[]> {
    const issues = await this.client.listIssues({ state: 'all' });
    const items: BacklogItem[] = [];
    for (const issue of issues) {
      const stateName = await this.client.getMatterStateName(issue.id);
      items.push(this.toBacklogItem(String(this.client.projectId), issue, stateName));
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

  async transition(id: string, state: BacklogState, _details?: { reason?: string; changeId?: string }): Promise<void> {
    const parsed = parseWorkItemId(id);
    const target = afkStateToNative(state);
    const current = await this.client.getMatterStateName(parsed.issueNumber);
    if (current === target) return; // the collapse of done/merge_ready makes this the common path
    await this.client.setStatus(parsed.issueNumber, target);
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

  private toBacklogItem(projectKey: string, issue: { id: number; title: string; description: string; labels: string[]; state: 'opened' | 'closed' | 'merged'; url: string }, stateName: string | undefined, workItemId?: BacklogItem['workItemId']): BacklogItem {
    const id = workItemId ?? `geelib:${projectKey}#${issue.id}`;
    const modeLabel = issue.labels.find(label => label === 'mode::afk' || label === 'mode::hitl');
    return {
      id,
      workItemId,
      issueNumber: issue.id,
      project: { platform: 'geelib', projectKey, name: projectKey },
      managed: true,
      executionEligible: true,
      state: nativeToAfkState(stateName ?? '') ?? (issue.state === 'closed' ? 'done' : 'ready'),
      labeledState: nativeToAfkState(stateName ?? ''),
      executionMode: modeLabel === 'mode::hitl' ? 'hitl' : 'afk',
      title: issue.title,
      description: issue.description || undefined,
      dependsOn: [],
      tags: issue.labels.filter(label => !RESERVED_LABEL_PREFIXES.some(prefix => label.startsWith(prefix))),
      branchName: '',
      providerRef: id,
      webUrl: issue.url,
    };
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
  applyRelationUpdate = this.refused('editing relations; the relation channel lands with the resource-reference slice');
  applyRole = this.refused('assigning the PRD role');
  applyExecutionBase = this.refused('recording the execution base');
  applyPrdBaseline = this.refused('recording the PRD baseline');
  applyDescription = this.refused('replacing the body');
  setExecutionMode = this.refused('switching the execution mode; pre-provision the mode:: tags instead');
  applyMode = this.refused('switching the execution mode; pre-provision the mode:: tags instead');
  createRework = this.refused('rework records; rework rides on the native rework state in this slice');
  getActiveRework = this.refused('rework records');
  resolveRework = this.refused('rework records');
  reviseRework = this.refused('rework records');
  async initialize(): Promise<void> {
    // The native state machine needs no provisioning.
  }
}
