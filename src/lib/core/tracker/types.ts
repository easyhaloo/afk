/**
 * Platform type
 */
export type Platform = 'gitlab' | 'github';

/**
 * Common list options
 */
export interface ListOptions {
  labels?: string[];
  state?: 'opened' | 'closed' | 'all';
  perPage?: number;
  projectId?: string;
}

/**
 * Create issue options
 */
export interface CreateIssueOptions {
  title: string;
  description?: string;
  labels?: string[];
}

/**
 * Update issue options
 */
export interface UpdateIssueOptions {
  title?: string;
  description?: string;
  state?: 'open' | 'closed';
  labels?: string[];
}

/**
 * List MR/PR options
 */
export interface ListMROptions {
  state?: 'opened' | 'closed' | 'all';
  perPage?: number;
  projectId?: string;
}

/**
 * Create MR/PR options
 */
export interface CreateMROptions {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
  labels?: string[];
}

/**
 * Merge MR/PR options
 */
export interface MergeMROptions {
  deleteSourceBranch?: boolean;
  squash?: boolean;
  mergeCommitMessage?: string;
}

/**
 * Approve MR/PR options
 */
export interface ApproveMROptions {
  sha?: string;  // GitLab: approve specific commit SHA
}

/**
 * Close MR/PR options
 */
export interface CloseMROptions {
  comment?: string;  // Optional comment when closing
}

/**
 * Link type for issue relationships
 */
export type LinkType = 'blocks' | 'is_blocked_by' | 'blocked_by' | 'related_to';

/**
 * Unified TrackedIssue across platforms
 */
export interface TrackedIssue {
  id: number;           // iid (GitLab) / number (GitHub)
  platform: Platform;
  title: string;
  description: string;
  labels: string[];
  state: 'opened' | 'closed' | 'merged';
  url: string;          // web_url (GitLab) / html_url (GitHub)
  projectId: string;   // GitLab: path, GitHub: owner/repo
}

/**
 * Unified TrackedMR across platforms
 */
export interface TrackedMR {
  id: number;
  platform: Platform;
  title: string;
  state: 'opened' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  url: string;
  projectId: string;
  pipeline?: { status: string };  // GitLab only
}

/**
 * Acceptance Criteria.
 *
 * `items` is ordered (by AC index when from labels, by source order when
 * from legacy markdown). `source` tells callers whether the data came
 * from the structured label path or the legacy markdown parser.
 */
export interface AcceptanceCriteria {
  items: string[];
  source: 'labels' | 'legacy' | 'none';
}

/**
 * TrackerProvider interface — unified for GitLab and GitHub
 */
export interface TrackerProvider {
  readonly platform: Platform;
  readonly projectId: string | number;

  // Issues
  getIssue(id: number): Promise<TrackedIssue>;
  listIssues(options?: ListOptions): Promise<TrackedIssue[]>;
  createIssue(options: CreateIssueOptions): Promise<number>;
  updateIssue(id: number, updates: UpdateIssueOptions): Promise<void>;
  addLabel(id: number, label: string): Promise<void>;
  removeLabel(id: number, label: string): Promise<void>;
  addComment(id: number, body: string): Promise<void>;
  linkIssues(sourceId: number, targetId: number, type: LinkType): Promise<void>;

  // MR/PR
  getMR(id: number): Promise<TrackedMR>;
  listMRs(options?: ListMROptions): Promise<TrackedMR[]>;
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
  approveMR(id: number, options?: ApproveMROptions): Promise<void>;
  closeMR(id: number, options?: CloseMROptions): Promise<void>;
  reopenMR(id: number): Promise<void>;

  // Utility
  parseAC(issue: Pick<TrackedIssue, 'labels' | 'description'>): AcceptanceCriteria;
  getRetryCount(issue: TrackedIssue): number;
  detectTargetBranch(issueId: number, explicit?: string): Promise<string>;
  uploadArtifacts(worktreePath: string): Promise<string>;
}
