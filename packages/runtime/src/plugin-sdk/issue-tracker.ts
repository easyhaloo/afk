export type IssueState = string;

export type IssueRelationType = 'blocks' | 'blocked-by' | 'relates-to' | 'duplicates';

export interface IssueTrackerIssue {
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly state: IssueState;
  readonly labels: readonly string[];
  readonly url?: string;
}

export interface IssueComment {
  readonly id: string;
  readonly issueId: string;
  readonly body: string;
  readonly author?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface IssueRelation {
  readonly id: string;
  readonly sourceIssueId: string;
  readonly targetIssueId: string;
  readonly type: IssueRelationType;
}

export interface CreateIssueInput {
  readonly title: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly issueType?: string;
}

export interface UpdateIssueInput {
  readonly title?: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly state?: IssueState;
}

export interface ListIssuesOptions {
  readonly state?: IssueState;
  readonly labels?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IssueTrackerPort {
  readonly id: string;
  readonly projectId: string;
  readonly baseUrl: string;

  getIssue(issueId: string): Promise<IssueTrackerIssue>;
  listIssues(options?: ListIssuesOptions): Promise<readonly IssueTrackerIssue[]>;
  createIssue(input: CreateIssueInput): Promise<IssueTrackerIssue>;
  updateIssue(issueId: string, input: UpdateIssueInput): Promise<IssueTrackerIssue>;
  deleteIssue(issueId: string): Promise<void>;

  addComment(issueId: string, body: string): Promise<IssueComment>;
  listComments(issueId: string): Promise<readonly IssueComment[]>;
  updateComment(issueId: string, commentId: string, body: string): Promise<IssueComment>;
  deleteComment(issueId: string, commentId: string): Promise<void>;

  linkIssues(sourceIssueId: string, targetIssueId: string, type: IssueRelationType): Promise<IssueRelation>;
  listIssueLinks(issueId: string): Promise<readonly IssueRelation[]>;

  health(): Promise<{ readonly status: 'ok' | 'degraded' | 'unavailable'; readonly message?: string }>;
  doctor(): Promise<readonly { readonly check: string; readonly ok: boolean; readonly detail?: string }[]>;
}

export type ChangeRequestState = 'open' | 'merged' | 'closed';

export interface ChangeRequest {
  readonly id: string;
  readonly title: string;
  readonly state: ChangeRequestState;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly description?: string;
  readonly url?: string;
}

export interface CreateChangeRequestInput {
  readonly title: string;
  readonly description?: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft?: boolean;
}

export interface ChangeProvider {
  create(input: CreateChangeRequestInput): Promise<ChangeRequest>;
  get(changeRequestId: string): Promise<ChangeRequest>;
  list(options?: { readonly state?: ChangeRequestState }): Promise<readonly ChangeRequest[]>;
  update(changeRequestId: string, input: { readonly title?: string; readonly description?: string }): Promise<ChangeRequest>;
  merge(changeRequestId: string): Promise<ChangeRequest>;
  close(changeRequestId: string): Promise<ChangeRequest>;
}
