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
  ApproveMROptions,
  CloseMROptions,
  AcceptanceCriteria,
  LinkType,
  Project,
  Branch,
  Tag,
  Commit,
} from '../tracker/types';
import { extractAC } from '../tracker/ac';
import { logger } from '../../io';

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
      state: data.state === 'open' ? 'opened' : 'closed',
      url: data.html_url,
      projectId: this.projectId,
    };
  }

  async listIssues(options: ListOptions = {}): Promise<TrackedIssue[]> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const state = options.state === 'opened' ? 'open' : options.state || 'open';
    const { data } = await oct.request('GET /repos/{owner}/{repo}/issues', {
      owner,
      repo,
      state,
      labels: options.labels?.join(','),
      per_page: options.perPage || 100,
    });
    // GitHub's `labels` query param is OR semantics (any label matches).
    // Enforce AND client-side so callers can require multiple labels.
    const required = options.labels ?? [];
    return data
      .filter(issue => !('pull_request' in issue)) // filter out PRs
      .filter(issue => {
        if (required.length === 0) return true;
        const names = issue.labels.map(l => (typeof l === 'string' ? l : (l.name || '')));
        return required.every(r => names.includes(r));
      })
      .map(issue => ({
        id: issue.number,
        platform: 'github' as const,
        title: issue.title,
        description: issue.body || '',
        labels: issue.labels.map(l => (typeof l === 'string' ? l : (l.name || ''))),
        state: issue.state === 'open' ? 'opened' : 'closed',
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

  async addLabel(id: number, label: string): Promise<void> {
    const issue = await this.getIssue(id);
    const newLabels = [...new Set([...issue.labels, label])];
    await this.updateIssueLabels(id, newLabels);
  }

  async removeLabel(id: number, label: string): Promise<void> {
    const issue = await this.getIssue(id);
    const newLabels = issue.labels.filter(l => l !== label);
    await this.updateIssueLabels(id, newLabels);
  }

  private async updateIssueLabels(id: number, labels: string[]): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    await oct.issues.update({
      owner,
      repo,
      issue_number: id,
      labels,
    });
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

  async linkIssues(sourceId: number, targetId: number, type: LinkType): Promise<void> {
    // GitHub doesn't have native issue links like GitLab
    // Use comments with issue references as workaround
    const linkMessage =
      type === 'blocks' ? `Blocks #${targetId}` :
      type === 'is_blocked_by' || type === 'blocked_by' ? `Blocked by #${targetId}` :
      `Related to #${targetId}`;

    await this.addComment(sourceId, linkMessage);
  }

  // ============ Pull Requests ============

  async getMR(id: number): Promise<TrackedMR> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await oct.pulls.get({
      owner,
      repo,
      pull_number: id,
    });
    const state = data.merged ? 'merged' : data.state === 'open' ? 'opened' : 'closed';
    return {
      id: data.number,
      platform: 'github',
      title: data.title,
      state,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      url: data.html_url,
      projectId: this.projectId,
    };
  }

  async listMRs(options: ListMROptions = {}): Promise<TrackedMR[]> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    const state = options.state === 'opened' ? 'open' : options.state || 'open';
    const { data } = await oct.pulls.list({
      owner,
      repo,
      state,
      per_page: options.perPage || 20,
    });
    return data.map(pr => {
      // merged property exists on individual PR get but may not on list
      const merged = (pr as any).merged;
      const prState = merged ? 'merged' : pr.state === 'open' ? 'opened' : 'closed';
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
        logger.warn({ mrId: id, err: String(error) }, 'failed to delete source branch');
      }
    }
  }

  async approveMR(id: number, options: ApproveMROptions = {}): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();

    await oct.pulls.createReview({
      owner,
      repo,
      pull_number: id,
      event: 'APPROVE',
      commit_id: options.sha,
    });
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

  async reopenMR(id: number): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();

    await oct.pulls.update({
      owner,
      repo,
      pull_number: id,
      state: 'open',
    });
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
    const { data } = await oct.repos.listBranches({ owner, repo, per_page: 100 });
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
    const { data } = await oct.repos.listTags({ owner, repo, per_page: 20 });
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

  // ============ Utility ============

  parseAC(issue: Pick<TrackedIssue, 'labels' | 'description'>): AcceptanceCriteria {
    return extractAC(issue);
  }

  getRetryCount(issue: TrackedIssue): number {
    const label = issue.labels.find(l => /^retry-count::\d+$/.test(l));
    if (!label) return 0;
    return parseInt(label.split('::')[1], 10);
  }

  async detectTargetBranch(issueId: number, explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const issue = await this.getIssue(issueId);
    const prdLabel = issue.labels.find(l => /^base::prd-\d+$/.test(l));
    if (prdLabel) return `prd/${prdLabel.replace('base::prd-', '')}`;
    return process.env.AFK_TARGET_BRANCH || 'main';
  }

  async uploadArtifacts(worktreePath: string): Promise<string> {
    // TODO: implement GitHub release asset upload
    return '';
  }
}
