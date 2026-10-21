import type { BacklogExecutionMode, BacklogState } from '../backlog-mapping.js';
import type { BacklogClaim } from './claim.js';
import type { BacklogProviderCapabilities } from './initialization.js';
import type { NewReworkRecord, ReworkRecord, ReworkResolution } from './rework-record.js';
import type { ProviderProjectRef } from '../work-items/types.js';
import type { WorkItemId } from '../work-items/identity.js';

/**
 * The states a change request can be in.
 *
 * The list is named because the backlog's model, its port, the tracker
 * adapter and the desktop's wire contract all describe a change
 * request, and each of them wrote the three names down.
 */
export const BACKLOG_CHANGE_REQUEST_STATES = ['open', 'merged', 'closed'] as const;

export type BacklogChangeRequestState = (typeof BACKLOG_CHANGE_REQUEST_STATES)[number];

export type BacklogChangeRequest = {
  id: string;
  state: BacklogChangeRequestState;
  sourceBranch: string;
  targetBranch: string;
  url?: string;
};

export interface BacklogItem {
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
  /** Optional backlog whose unmerged branch is the explicit execution base. */
  baseBacklogId?: string;
  dependsOn: string[];
  state: BacklogState;
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
 * Moving a backlog item's lifecycle: the state it is in, and the mode it
 * runs under.
 *
 * This is the narrowest write the backlog has.  A run claims an item and
 * moves it; a handoff that has run out of road flips one to blocked/hitl.
 * Neither of them creates a backlog item, claims one it was not handed, or
 * rewrites its tags.
 */
export interface BacklogLifecycle {
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void>;
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void>;
}

/**
 * The execution surface: the items a run may take, and the work it may
 * claim.
 */
export interface BacklogExecutionProvider extends BacklogLifecycle {
  get(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  claim(id: string, owner: string): Promise<BacklogClaim | null>;
  isRunnable(item: BacklogItem): Promise<boolean>;
  /** The rework record a run has to honour, if one is open. */
  getActiveRework(id: string): Promise<ReworkRecord | undefined>;
}

/**
 * Writing the rework record of one backlog item.
 */
export interface BacklogReworkWriter {
  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord>;
  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void>;
}

/**
 * The non-execution surface shared by backlog administration and QA.
 * It deliberately omits claim() so callers cannot start implementation work.
 */
export interface BacklogManagementProvider {
  get(id: string): Promise<BacklogItem>;
  adopt?(id: string): Promise<BacklogItem>;
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
  create(input: BacklogCreateInput): Promise<BacklogItem>;
  addTag(id: string, tag: string): Promise<void>;
  removeTag(id: string, tag: string): Promise<void>;
  initialize(): Promise<void>;
}

/** QA may update lifecycle state, but it never claims implementation work. */
export interface QABacklogProvider extends BacklogManagementProvider, BacklogLifecycle, BacklogReworkWriter {
  getActiveRework(id: string): Promise<ReworkRecord | undefined>;
}

/**
 * A backlog, whole.
 *
 * The slices above are what a caller usually wants.  A run reads and claims
 * items; QA writes the rework record and moves the lifecycle; the
 * administration surface creates items and owns their tags.  A caller that
 * depends on the whole backlog can, but the compiler will not make it.
 */
export interface BacklogProvider extends BacklogManagementProvider, BacklogExecutionProvider, BacklogReworkWriter {
  readonly capabilities?: BacklogProviderCapabilities;
}

export function deriveBacklogBranchName(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('backlog id must contain at least one usable character');
  return `afk/backlog-${normalized}`;
}
