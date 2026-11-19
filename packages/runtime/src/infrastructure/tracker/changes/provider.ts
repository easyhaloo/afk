import type { BacklogItem } from '../../../domain/backlog/index.js';
import type { ChangeAssociationOptions } from '../../../domain/backlog/change-association.js';
import type { ChangeMergeState } from '../../../domain/tracker/types.js';
import type { VerificationEvidence } from './verification-evidence.js';

export interface ChangeRequest {
  id: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  mergeable?: boolean;
  /**
   * The precise merge verdict. 'conflict' means the two branches changed the
   * same lines; 'unknown' covers a verdict the platform has not computed or
   * a reason that is not a conflict.
   */
  mergeState?: ChangeMergeState;
  url?: string;
  /** The body of the change request — it names the issues it closes. */
  description?: string;
}

export interface CreateChangeInput {
  backlog: BacklogItem;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
  /** What the QA run proved; rendered into the description. */
  evidence?: Omit<VerificationEvidence, 'artifacts'>;
  /** Worktree holding `.afk/artifacts.txt`; enables artifact upload. */
  worktreePath?: string;
  /** Commit the artifact release points at. */
  commitSha?: string;
}

export interface ChangeProvider {
  create(input: CreateChangeInput): Promise<ChangeRequest>;
  get(id: string): Promise<ChangeRequest>;
  /**
   * The change request of a backlog item.
   *
   * One branch can carry several changes, so the association is a decision
   * with a rule rather than the first change a listing happens to return. The
   * caller that knows where the work was headed says so in the options.
   */
  findForBacklog(backlog: BacklogItem, options?: ChangeAssociationOptions): Promise<ChangeRequest | null>;
  /**
   * Every change request that shares a branch of a backlog item.
   *
   * It is optional because a provider that knows one change per item has
   * nothing to list. Where it is there, a failed reconciliation can name the
   * changes it had to choose between.
   */
  listForBacklog?(backlog: BacklogItem): Promise<ChangeRequest[]>;
  verifyIssueAssociation(change: ChangeRequest, canonicalWorkItemId: string): Promise<void>;
  /**
   * Refresh the body of a change request that already exists.
   *
   * The evidence is rendered by the provider, because the body is its
   * business: which issue the change closes and how the provider spells it
   * differ per platform.
   */
  refresh?(id: string, backlog: BacklogItem, evidence: Omit<VerificationEvidence, 'artifacts'>, worktreePath?: string): Promise<ChangeRequest>;
  merge(id: string): Promise<void>;
  close(id: string, reason?: string): Promise<void>;
}
