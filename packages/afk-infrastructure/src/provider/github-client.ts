import { Octokit } from '@octokit/rest';
import type {
  TrackerProvider,
  TrackedIssue,
  TrackedMR,
  ListOptions,
  CreateIssueOptions,
  UpdateIssueOptions,
  ListMROptions,
  CreateMROptions,
  MergeMROptions,
  CloseMROptions,
  LinkType,
  Project,
  Branch,
  Tag,
  Commit,
  TrackerIssueComment,
  LabelDelta,
} from '@afk/application';
import type { BacklogMetadataLabel } from '@afk/application';
import type { TrackerIssueFilterState, TrackerIssueState } from '@afk/application';

/**
 * GitHub calls an open issue "open"; AFK calls it "opened".
 *
 * The client reads a state in four places and asks for one in two, and
 * each of them used to spell the rule out. A copy of the rule left
 * behind reports an open issue as a closed one - a backlog item nobody
 * can act on - and the copies can disagree with each other.
 */
function toTrackedState(githubState: string): TrackerIssueState {
  return githubState === 'open' ? 'opened' : 'closed';
}

function toTrackedMergeRequestState(githubState: string, merged: boolean): TrackerIssueState {
  return merged ? 'merged' : toTrackedState(githubState);
}

/** The state AFK asks GitHub for. */
function toGithubState(state: TrackerIssueFilterState | undefined): 'open' | 'closed' | 'all' {
  if (state === 'all') return 'all';
  return state === 'closed' ? 'closed' : 'open';
}
import { logger } from '../io/index.js';
import { parseWorkItemId } from '@afk/application';

/**
 * GitHub authentication options
 */
export interface GitHubAuthOptions {
  auth?: string;        // token or gh CLI auth
  repo: string;         // owner/repo
}

/**
 * GitHub client implementing TrackerProvider.
 *
 * Authentication is the caller's responsibility — pass a token via the
 * `auth` option (or constructor of createGitHubClient). Octokit is the
 * SDK; AFK does NOT shell out to `gh auth token` to avoid parsing
 * CLI stdout across gh versions.
 */
export class GitHubClient implements TrackerProvider {
  readonly platform: 'github' = 'github';
  readonly projectId: string;
  private client: Octokit;

  constructor(options: GitHubAuthOptions) {
    if (!options.auth) {
      throw new Error('GitHubClient requires auth token. Set GITHUB_TOKEN env, or pass { auth } to constructor.');
    }
    this.projectId = options.repo;
    this.client = new Octokit({
      auth: options.auth,
      userAgent: 'afk v1',
      mediaType: {
        format: '2022-11-28',
      },
    });
  }

  private getOwnerRepo(): { owner: string; repo: string } {
    const [owner, repo] = this.projectId.split('/');
    if (!owner || !repo) throw new Error(`Invalid repo format: ${this.projectId}`);
    return { owner, repo };
  }

  // ============ Issues ============

  async getIssue(id: number): Promise<TrackedIssue> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await oct.issues.get({ owner, repo, issue_number: id });
    return {
      id: data.number,
      platform: 'github',
      title: data.title,
      description: data.body || '',
      labels: data.labels.map(l => (typeof l === 'string' ? l : (l.name || ''))),
      state: toTrackedState(data.state),
      url: data.html_url,
      projectId: this.projectId,
    };
  }

  /**
   * Read every page of a GitHub list.
   *
   * A request here is one request: the endpoint answers with a page and no
   * more.  The tracker asks for everything — a backlog's change request,
   * the comments a rework record lives in — so a list that stopped at the
   * first page was a list that was quietly short.  A page that comes back
   * shorter than the page size is the last one.
   */
  private async listAllPages<T>(
    load: (page: number) => Promise<{ data: T[] }>,
    perPage: number,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page += 1) {
      const { data } = await load(page);
      all.push(...data);
      if (data.length < perPage) break;
    }
    return all;
  }

  async listIssues(options: ListOptions = {}): Promise<TrackedIssue[]> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const state = toGithubState(options.state);
    // The caller asked for every issue, and a request here is one
    // request: the repository's issues endpoint answers with a page and
    // no more.  A repository with more issues than that in it was
    // silently short, and the backlog board showed the first hundred.
    const perPage = options.perPage || 100;
    // GitHub's `labels` query param is OR semantics (any label matches).
    // Enforce AND client-side so callers can require multiple labels.
    const required = options.labels ?? [];
    const pages = await this.listAllPages(async (page) => {
      const { data } = await oct.request('GET /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        state,
        labels: options.labels?.join(','),
        per_page: perPage,
        page,
      });
      return { data };
    }, perPage);
    return pages
      .filter(issue => !('pull_request' in issue)) // filter out PRs
      .filter(issue => {
        if (required.length === 0) return true;
        const names = issue.labels.map(l => (typeof l === 'string' ? l : (l.name || '')));
        return required.every(r => names.includes(r));
      })
      .map((issue): TrackedIssue => ({
        id: issue.number,
        platform: 'github' as const,
        title: issue.title,
        description: issue.body || '',
        labels: issue.labels.map(l => (typeof l === 'string' ? l : (l.name || ''))),
        state: toTrackedState(issue.state),
        url: issue.html_url,
        projectId: this.projectId,
      }));
  }

  async createIssue(options: CreateIssueOptions): Promise<number> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await oct.issues.create({
      owner,
      repo,
      title: options.title,
      body: options.description,
      labels: options.labels,
    });
    return data.number;
  }

  /** Create AFK lifecycle labels when absent, without overwriting repository-owned metadata. */
  async ensureBacklogMetadata(labels: readonly BacklogMetadataLabel[]): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    for (const label of labels) {
      try {
        await oct.issues.getLabel({ owner, repo, name: label.name });
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
        try {
          await oct.issues.createLabel({
            owner,
            repo,
            name: label.name,
            color: label.color,
            description: label.description,
          });
        } catch (createError) {
          // A concurrent AFK process can create the same label after our GET.
          if (statusCode(createError) !== 422) throw createError;
        }
      }
    }
  }

  async updateIssue(id: number, updates: UpdateIssueOptions): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    await oct.issues.update({
      owner,
      repo,
      issue_number: id,
      title: updates.title,
      body: updates.description,
      state: updates.state,
      labels: updates.labels,
    });
  }

  async updateLabels(id: number, delta: LabelDelta): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const remove = [...new Set(delta.remove)];
    const add = [...new Set(delta.add.filter(label => !remove.includes(label)))];
    for (const name of remove) {
      await oct.issues.removeLabel({ owner, repo, issue_number: id, name });
    }
    if (add.length > 0) {
      await oct.issues.addLabels({ owner, repo, issue_number: id, labels: add });
    }
  }

  async addComment(id: number, body: string): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    await oct.issues.createComment({
      owner,
      repo,
      issue_number: id,
      body,
    });
  }

  async listIssueComments(id: number): Promise<TrackerIssueComment[]> {
    const { owner, repo } = this.getOwnerRepo();
    const data = await this.listAllPages(page => this.client.issues.listComments({ owner, repo, issue_number: id, per_page: 100, page }), 100);
    return data.map(comment => ({ id: String(comment.id), body: comment.body ?? '' }));
  }

  async updateIssueComment(_id: number, commentId: string, body: string): Promise<void> {
    const { owner, repo } = this.getOwnerRepo();
    await this.client.issues.updateComment({ owner, repo, comment_id: Number(commentId), body });
  }

  async linkIssues(sourceId: number, targetId: number, type: LinkType, targetProjectId?: string): Promise<void> {
    // GitHub doesn't have native issue links like GitLab.
    // Cross-repo references use the full `owner/repo#N` form, which GitHub
    // renders as a real <a> link even across visibility (private refs show
    // "Title is private" instead of failing).
    const targetRef = targetProjectId ? `${targetProjectId}#${targetId}` : `#${targetId}`;
    const linkMessage =
      type === 'blocks' ? `Blocks ${targetRef}` :
      type === 'is_blocked_by' || type === 'blocked_by' ? `Blocked by ${targetRef}` :
      `Related to ${targetRef}`;

    await this.addComment(sourceId, linkMessage);
  }

  // ============ Pull Requests ============

  async isMRLinkedToIssue(id: number, canonicalWorkItemId: string): Promise<boolean> {
    const issue = parseWorkItemId(canonicalWorkItemId);
    if (issue.platform !== 'github') throw new Error('GitHub PR requires a GitHub issue');
    const [owner, repo, extra] = issue.projectKey.split('/');
    if (!owner || !repo || extra) throw new Error('GitHub issue project key must be owner/repo');
    const query = `query($owner: String!, $repo: String!, $pullRequest: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pullRequest) {
          closingIssuesReferences(first: 100) {
            nodes { number repository { nameWithOwner } }
          }
        }
      }
    }`;
    const response: {
      repository?: { pullRequest?: { closingIssuesReferences?: {
        nodes?: ({ number: number; repository?: { nameWithOwner: string } } | null)[];
      } } };
    } = await this.client.graphql(query, { ...this.getOwnerRepo(), pullRequest: id });
    const references = response.repository?.pullRequest?.closingIssuesReferences;
    if (!references || !Array.isArray(references.nodes)) throw new Error('GitHub PR linkage readback unavailable');
    return references.nodes.some(linked => linked?.number === issue.issueNumber
      && linked.repository?.nameWithOwner.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  }

  async getMR(id: number): Promise<TrackedMR> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await oct.pulls.get({
      owner,
      repo,
      pull_number: id,
    });
    const state = toTrackedMergeRequestState(data.state, data.merged);
    return {
      id: data.number,
      platform: 'github',
      title: data.title,
      state,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      mergeable: data.mergeable ?? undefined,
      url: data.html_url,
      projectId: this.projectId,
    };
  }

  async listMRs(options: ListMROptions = {}): Promise<TrackedMR[]> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const state = toGithubState(options.state);
    const perPage = options.perPage || 100;
    const data = await this.listAllPages(page => oct.pulls.list({
      owner,
      repo,
      state,
      per_page: perPage,
      page,
    }), perPage);
    return data.map(pr => {
      // The list answer carries `merged_at`, not the `merged` flag the
      // single read carries. GitHub reports a merged pull request as
      // closed as well, so the timestamp is what tells the two apart.
      const mergedAt = (pr as { merged_at?: string | null }).merged_at;
      const prState = toTrackedMergeRequestState(pr.state, !!mergedAt);
      return {
        id: pr.number,
        platform: 'github' as const,
        title: pr.title,
        state: prState,
        sourceBranch: pr.head.ref,
        targetBranch: pr.base.ref,
        url: pr.html_url,
        projectId: this.projectId,
      };
    });
  }

  async createMR(options: CreateMROptions): Promise<number> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await oct.pulls.create({
      owner,
      repo,
      title: options.title,
      body: options.description || '',
      head: options.sourceBranch,
      base: options.targetBranch,
      draft: options.draft ?? false,
    });

    // Add labels if specified
    if (options.labels && options.labels.length > 0) {
      await oct.issues.addLabels({
        owner,
        repo,
        issue_number: data.number,
        labels: options.labels,
      });
    }

    return data.number;
  }

  async mergeMR(id: number, options: MergeMROptions = {}): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();

    await oct.pulls.merge({
      owner,
      repo,
      pull_number: id,
      commit_message: options.mergeCommitMessage,
      merge_method: options.squash ? 'squash' : 'merge',
    });

    // Delete source branch if requested
    if (options.deleteSourceBranch) {
      try {
        const pr = await this.getMR(id);
        await oct.git.deleteRef({
          owner,
          repo,
          ref: `heads/${pr.sourceBranch}`,
        });
      } catch (error) {
        // Branch deletion is best-effort, don't fail the merge
        logger.warn({ mrId: id, err: error }, 'failed to delete source branch');
      }
    }
  }

  async closeMR(id: number, options: CloseMROptions = {}): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();

    await oct.pulls.update({
      owner,
      repo,
      pull_number: id,
      state: 'closed',
    });

    if (options.comment) {
      await oct.issues.createComment({
        owner,
        repo,
        issue_number: id,
        body: options.comment,
      });
    }
  }

  // ============ Projects ============

  async listProjects(options: { page?: number; perPage?: number } = {}): Promise<Project[]> {
    // GitHub doesn't have a concept of "projects" like GitLab
    // Return the current repo as a single project
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await oct.repos.get({ owner, repo });
    return [{
      id: data.id,
      platform: 'github',
      name: data.name,
      path_with_namespace: data.full_name,
      description: data.description || undefined,
      default_branch: data.default_branch,
      namespace: { name: data.owner.login },
      last_activity_at: data.pushed_at || undefined,
      web_url: data.html_url,
    }];
  }

  async getBranches(projectId: number): Promise<Branch[]> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const data = await this.listAllPages(page => oct.repos.listBranches({ owner, repo, per_page: 100, page }), 100);
    return data.map(branch => {
      // GitHub's list-branches commit object only has sha and url
      // Cast to any to access the full commit object if available
      const commit = branch.commit as any;
      return {
        name: branch.name,
        commit: branch.commit.sha.substring(0, 8),
        commit_title: '',
        author: commit.author?.login || '',
        committed_date: commit.commit?.author?.date || '',
        protected: branch.protected,
      };
    });
  }

  async getTags(projectId: number): Promise<Tag[]> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const data = await this.listAllPages(page => oct.repos.listTags({ owner, repo, per_page: 100, page }), 100);
    return data.map(tag => ({
      name: tag.name,
      commit: tag.commit.sha.substring(0, 8),
    }));
  }

  async getRecentCommits(projectId: number, perPage: number = 5): Promise<Commit[]> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await oct.repos.listCommits({ owner, repo, per_page: perPage });
    return data.map(commit => ({
      id: commit.sha.substring(0, 8),
      title: commit.commit.message.split('\n')[0],
      author: commit.commit.author?.name || '',
      committed_date: commit.commit.author?.date || '',
    }));
  }

}

function statusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined;
}
