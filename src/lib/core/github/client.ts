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
} from '../tracker/types';

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
    this.client = new Octokit({ auth: options.auth });
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
    const { data } = await oct.issues.list({
      owner,
      repo,
      state,
      labels: options.labels?.join(','),
      per_page: options.perPage || 20,
    });
    return data
      .filter(issue => !('pull_request' in issue)) // filter out PRs
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
        console.warn(`Failed to delete source branch: ${error}`);
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

  // ============ Utility ============

  parseAC(description: string): AcceptanceCriteria | null {
    const acMatch = description.match(
      /##\s*(?:AC|Acceptance Criteria)\s*\n([\s\S]*?)(?=\n##|$)/i
    );
    if (!acMatch) return null;

    const acText = acMatch[1].trim();
    const items: string[] = [];
    const itemRegex = /^[-*]\s+\[\s*\]\s+(.+)$/gm;
    let match;
    while ((match = itemRegex.exec(acText)) !== null) {
      items.push(match[1].trim());
    }

    return { text: acText, items };
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
