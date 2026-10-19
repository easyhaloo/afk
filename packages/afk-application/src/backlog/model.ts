import type { BacklogExecutionMode, BacklogState } from '../backlog-mapping.js';
import type { BacklogClaim } from './claim.js';
import type { BacklogProviderCapabilities } from './initialization.js';
import type { NewReworkRecord, ReworkRecord, ReworkResolution } from './rework-record.js';
import type { ProviderProjectRef } from '../work-items/types.js';
import type { WorkItemId } from '../work-items/identity.js';

export type BacklogChangeRequest = {
  id: string;
  state: 'open' | 'merged' | 'closed';
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
export interface QABacklogProvider extends BacklogManagementProvider {
  transition(id: string, state: BacklogState, details?: { reason?: string; changeId?: string }): Promise<void>;
  setExecutionMode(id: string, mode: BacklogExecutionMode): Promise<void>;
  createRework(id: string, record: NewReworkRecord): Promise<ReworkRecord>;
  getActiveRework(id: string): Promise<ReworkRecord | undefined>;
  resolveRework(id: string, reworkId: string, resolution: ReworkResolution): Promise<void>;
}

export interface BacklogProvider {
  readonly capabilities?: BacklogProviderCapabilities;
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

export function deriveBacklogBranchName(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('backlog id must contain at least one usable character');
  return `afk/backlog-${normalized}`;
}
