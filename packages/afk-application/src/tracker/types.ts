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

export interface LabelDelta {
  add: string[];
  remove: string[];
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

export interface TrackerIssueComment {
  id: string;
  body: string;
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
  mergeable?: boolean;
  pipeline?: { status: string };  // GitLab only
}

import type { BacklogMetadataLabel } from '../backlog/initialization.js';
import type { WorkItemPlatform } from '../work-items/identity.js';

/**
 * Which tracker, and which project on it.
 */
export interface TrackerIdentity {
  readonly platform: Platform;
  readonly projectId: string | number;
  readonly providerHost?: string;
}

/**
 * Reading the issues of a tracker.
 */
export interface TrackerIssueReader extends TrackerIdentity {
  getIssue(id: number): Promise<TrackedIssue>;
  listIssues(options?: ListOptions): Promise<TrackedIssue[]>;
}

/**
 * Reading and writing the issues of a tracker.
 */
export interface TrackerIssueOperations extends TrackerIssueReader {
  createIssue(options: CreateIssueOptions): Promise<number>;
  updateIssue(id: number, updates: UpdateIssueOptions): Promise<void>;
  updateLabels(id: number, delta: LabelDelta): Promise<void>;
  addComment(id: number, body: string): Promise<void>;
  listIssueComments(id: number): Promise<TrackerIssueComment[]>;
  updateIssueComment(id: number, commentId: string, body: string): Promise<void>;
  /** Optionally provision provider-native labels required by AFK backlog metadata. */
  ensureBacklogMetadata?(labels: readonly BacklogMetadataLabel[]): Promise<void>;
  /**
   * Link source issue to target issue. For cross-project links, pass
   * `targetProjectId` (GitLab path or GitHub owner/repo). Without it, both
   * ends are assumed to be in `this.projectId` (same-repo link).
   */
  linkIssues(sourceId: number, targetId: number, type: LinkType, targetProjectId?: string): Promise<void>;
}

/**
 * The merge requests of a tracker, read.
 */
export interface TrackerMergeReader extends TrackerIdentity {
  getMR(id: number): Promise<TrackedMR>;
  isMRLinkedToIssue(id: number, canonicalWorkItemId: string): Promise<boolean>;
  listMRs(options?: ListMROptions): Promise<TrackedMR[]>;
}

/**
 * The merge requests of a tracker, written.
 */
export interface TrackerMergeWriter extends TrackerIdentity {
  createMR(options: CreateMROptions): Promise<number>;
  mergeMR(id: number, options?: MergeMROptions): Promise<void>;
  closeMR(id: number, options?: CloseMROptions): Promise<void>;
}

/**
 * The projects of a tracker.
 */
export interface TrackerProjectReader extends TrackerIdentity {
  listProjects(options?: { page?: number; perPage?: number }): Promise<Project[]>;
  getBranches(projectId: number): Promise<Branch[]>;
  getTags(projectId: number): Promise<Tag[]>;
  getRecentCommits(projectId: number, perPage?: number): Promise<Commit[]>;
}

/**
 * A tracker, whole.
 *
 * The slices above are what a caller usually wants: the backlog adapter
 * reads issues and merge requests, the changes adapter writes merge
 * requests, the board reads projects. A caller that depends on the whole
 * tracker can, but the compiler will not make it.
 */
export interface TrackerProvider extends TrackerIssueOperations, TrackerMergeReader, TrackerMergeWriter, TrackerProjectReader {
  /**
   * Upload the run's artifacts and return the markdown that shows them.
   *
   * Optional: a platform with nowhere to put artifacts does not offer it.
   * GitLab uploads the files the worktree's `.afk/artifacts.txt` names to
   * the project; GitHub has no equivalent, so the GitLab adapter has this
   * method and the GitHub adapter simply does not — asking it to publish
   * artifacts finds no method, rather than an empty answer that looks
   * like a successful upload of nothing.
   */
  uploadArtifacts?(worktreePath: string): Promise<string>;
}

/**
 * Unified project representation
 */
export interface Project {
  id: number;
  /** Provider identity used by the multi-provider dashboard. */
  platform?: WorkItemPlatform;
  name: string;
  path_with_namespace: string;
  description?: string;
  default_branch?: string;
  namespace: { name: string };
  last_activity_at?: string;
  web_url?: string;
}

/**
 * Unified branch representation
 */
export interface Branch {
  name: string;
  commit: string;
  commit_title?: string;
  author?: string;
  committed_date?: string;
  protected?: boolean;
}

/**
 * Unified tag representation
 */
export interface Tag {
  name: string;
  commit: string;
  commit_author?: string;
  commit_date?: string;
  message?: string;
}

/**
 * Unified commit representation
 */
export interface Commit {
  id: string;
  title: string;
  author?: string;
  committed_date?: string;
}

