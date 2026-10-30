import { Octokit } from '@octokit/rest';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  TrackerProvider,
  TrackedIssue,
  TrackedMR,
  ChangeMergeState,
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
  TrackerIssueComment,
  LabelDelta,
  UploadedArtifact,
  UploadArtifactsOptions,
} from '../../domain/tracker/types.js';
import { extractAC } from '../../domain/tracker/ac.js';
import type { BacklogMetadataLabel } from '../../domain/backlog/initialization.js';
import { logger } from '../io/index.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';

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

  constructor(private readonly options: GitHubAuthOptions) {
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

  forProject(projectKey: string): GitHubClient {
    if (projectKey.split('/').length !== 2) throw new Error('GitHub relationship project must use owner/repo');
    return new GitHubClient({ ...this.options, repo: projectKey });
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

  async listIssueComments(id: number): Promise<TrackerIssueComment[]> {
    const { owner, repo } = this.getOwnerRepo();
    const { data } = await this.client.issues.listComments({ owner, repo, issue_number: id, per_page: 100 });
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
    // A relation that is already written is not written again: a repeated
    // run has to leave the record the way it found it.
    const written = await this.listIssueComments(sourceId);
    if (written.some(comment => comment.body === linkMessage)) return;

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

  async updateMR(id: number, updates: { description?: string }): Promise<void> {
    const oct = this.client;
    const { owner, repo } = this.getOwnerRepo();
    await oct.pulls.update({ owner, repo, pull_number: id, ...(updates.description !== undefined ? { body: updates.description } : {}) });
  }

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
      ...(data.body ? { description: data.body } : {}),
      mergeable: data.mergeable ?? undefined,
      mergeState: githubMergeState(data.mergeable_state, data.mergeable),
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
        logger.warn({ mrId: id, err: error }, 'failed to delete source branch');
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

  async uploadArtifacts(worktreePath: string, options: UploadArtifactsOptions = {}): Promise<UploadedArtifact[]> {
    const paths = await readArtifactPaths(join(worktreePath, '.afk', 'artifacts.txt'));
    if (paths.length === 0) return [];
    const { owner, repo } = this.getOwnerRepo();
    const release = await this.ensureArtifactRelease(owner, repo, options);
    const artifacts: UploadedArtifact[] = [];
    for (const path of paths) {
      const name = basename(path);
      try {
        const data = await readFile(path);
        await this.removeExistingAsset(owner, repo, release.id, name);
        const asset = await this.client.repos.uploadReleaseAsset({
          owner,
          repo,
          release_id: release.id,
          name,
          // Octokit types the request body as a string, but the asset endpoint
          // takes the raw bytes: the endpoint parser passes a Buffer through
          // to fetch unchanged.
          data: data as unknown as string,
          headers: { 'content-type': 'application/octet-stream' },
        });
        artifacts.push({ name, url: asset.data.browser_download_url });
      } catch (error) {
        // Best-effort: one unreadable artifact must not fail the whole run.
        logger.warn({ owner, repo, releaseId: release.id, path, error }, 'failed to upload QA artifact');
      }
    }
    return artifacts;
  }

  /**
   * GitHub rejects a second asset with the same name, so a re-run has to drop
   * the previous file before it can upload its own.
   */
  private async removeExistingAsset(owner: string, repo: string, releaseId: number, name: string): Promise<void> {
    const existing = await this.client.repos.listReleaseAssets({ owner, repo, release_id: releaseId, per_page: 100 });
    const clash = existing.data.find(asset => asset.name === name);
    if (clash) await this.client.repos.deleteReleaseAsset({ owner, repo, asset_id: clash.id });
  }

  /**
   * QA artifacts live in a pre-release so the link in the change request
   * opens for the reviewer without a token. A draft release would 404 on its
   * browser download URL: GitHub only serves those through the
   * authenticated API endpoint, which is not clickable in a browser.
   */
  private async ensureArtifactRelease(
    owner: string,
    repo: string,
    options: UploadArtifactsOptions,
  ): Promise<{ id: number }> {
    const tag = artifactReleaseTag(options);
    const existing = await this.client.repos.listReleases({ owner, repo, per_page: 100 });
    const found = existing.data.find(release => release.tag_name === tag);
    if (found) return { id: found.id };
    const created = await this.client.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: `AFK QA artifacts${options.backlogId ? ` for backlog ${options.backlogId}` : ''}`,
      body: 'Verification artifacts uploaded by the AFK QA runner.',
      draft: false,
      prerelease: true,
      target_commitish: options.targetCommitish ?? options.sourceBranch,
    });
    return { id: created.data.id };
  }
}

function statusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined;
}

/**
 * Read the artifact manifest a QA run leaves in its worktree. One absolute
 * path per line; a missing manifest means the run registered no artifacts.
 */
export async function readArtifactPaths(markerPath: string): Promise<string[]> {
  try {
    const content = await readFile(markerPath, 'utf-8');
    return content.split('\n').map(line => line.trim()).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * One artifact release per backlog item, so a re-run reuses the release it
 * created instead of piling up drafts.
 */
export function artifactReleaseTag(options: UploadArtifactsOptions): string {
  const id = options.backlogId?.replace(/[^A-Za-z0-9._-]/g, '-');
  return id ? `afk-qa-artifacts-${id}` : 'afk-qa-artifacts';
}

/**
 * Translate GitHub's merge verdict into the precise state AFK acts on.
 *
 * GitHub reports 'dirty' when the branches changed the same lines, and
 * 'blocked' or 'behind' for reasons that a person does not have to resolve
 * by hand. Only 'dirty' is a conflict; a null verdict means GitHub has not
 * computed it yet.
 */
function githubMergeState(mergeableState: string | null | undefined, mergeable: boolean | null | undefined): ChangeMergeState {
  if (mergeableState === 'dirty') return 'conflict';
  if (mergeableState === 'clean') return 'mergeable';
  if (mergeable === true) return 'mergeable';
  return 'unknown';
}
