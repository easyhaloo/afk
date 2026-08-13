import { Gitlab } from '@gitbeaker/node';
import { simpleGit } from 'simple-git';
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
  TrackerIssueComment,
  LabelDelta,
} from '../../domain/tracker/types';
import { extractAC } from '../../domain/tracker/ac';

export interface GitLabConfig {
  url: string;
  token: string;
  projectId: string | number;
}

/**
 * Detect GitLab project path from the 'origin' remote URL.
 */
export async function detectGitLabProject(cwd?: string): Promise<string | null> {
  try {
    const git = simpleGit(cwd || process.cwd());
    const cfg = await git.getConfig('remote.origin.url');
    const url = cfg.value;
    if (!url) return null;

    const project = url
      .replace(/^git@[^:]+:/, '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/\.git$/, '')
      .trim();

    return project || null;
  } catch {
    return null;
  }
}

/**
 * GitLab client wrapper implementing TrackerProvider interface
 */
export class GitLabClient implements TrackerProvider {
  readonly platform: 'gitlab' = 'gitlab';
  readonly projectId: string | number;
  private client: InstanceType<typeof Gitlab>;

  constructor(config: GitLabConfig) {
    this.client = new Gitlab({
      host: config.url,
      token: config.token,
    });
    this.projectId = config.projectId;
  }

  async getIssue(id: number): Promise<TrackedIssue> {
    const issue = await this.client.Issues.show(this.projectId, id) as any;
    return {
      id: issue.iid,
      platform: 'gitlab',
      title: issue.title,
      description: issue.description || '',
      labels: issue.labels as string[],
      state: issue.state === 'opened' ? 'opened' : 'closed',
      url: issue.web_url,
      projectId: String(this.projectId),
    };
  }

  async listIssues(options: ListOptions = {}): Promise<TrackedIssue[]> {
    const issues = await this.client.Issues.all({
      projectId: this.projectId,
      labels: options.labels?.join(','),
      state: options.state || 'opened',
      perPage: options.perPage || 20,
    }) as any[];
    return issues.map(issue => ({
      id: issue.iid as number,
      platform: 'gitlab' as const,
      title: issue.title as string,
      description: (issue.description || '') as string,
      labels: (issue.labels || []) as string[],
      state: issue.state === 'opened' ? 'opened' : 'closed',
      url: issue.web_url as string,
      projectId: String(this.projectId),
    }));
  }

  async createIssue(options: CreateIssueOptions): Promise<number> {
    const issue = await this.client.Issues.create(this.projectId, {
      title: options.title,
      description: options.description || '',
      labels: options.labels?.join(',') || '',
    }) as any;
    return issue.iid;
  }

  async updateIssue(id: number, updates: UpdateIssueOptions): Promise<void> {
    const editData: any = {};
    if (updates.title !== undefined) editData.title = updates.title;
    if (updates.description !== undefined) editData.description = updates.description;
    if (updates.state !== undefined) editData.state_event = updates.state === 'closed' ? 'close' : 'reopen';
    if (updates.labels !== undefined) editData.labels = updates.labels.join(',');
    await this.client.Issues.edit(this.projectId, id, editData);
  }

  async addLabel(id: number, label: string): Promise<void> {
    const issue = await this.getIssue(id);
    const newLabels = [...new Set([...issue.labels, label])];
    await this.updateIssue(id, { labels: newLabels });
  }

  async removeLabel(id: number, label: string): Promise<void> {
    const issue = await this.getIssue(id);
    const newLabels = issue.labels.filter(l => l !== label);
    await this.updateIssue(id, { labels: newLabels });
  }

  async addComment(id: number, body: string): Promise<void> {
    await this.client.IssueNotes.create(this.projectId, id, body);
  }

  async listIssueComments(id: number): Promise<TrackerIssueComment[]> {
    const notes = await this.client.IssueNotes.all(this.projectId, id, { perPage: 100 }) as any[];
    return notes.map(note => ({ id: String(note.id), body: note.body ?? '' }));
  }

  async updateIssueComment(id: number, commentId: string, body: string): Promise<void> {
    await this.client.IssueNotes.edit(this.projectId, id, Number(commentId), body);
  }

  async linkIssues(sourceId: number, targetId: number, type: LinkType, targetProjectId?: string): Promise<void> {
    await this.client.Issues.link(
      this.projectId,
      sourceId,
      targetProjectId ?? this.projectId,
      targetId,
      { link_type: type }
    );
  }

  async getMR(id: number): Promise<TrackedMR> {
    const mr = await this.client.MergeRequests.show(this.projectId, id) as any;
    return {
      id: mr.iid,
      platform: 'gitlab',
      title: mr.title,
      state: mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'opened' : 'closed',
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      url: mr.web_url,
      projectId: String(this.projectId),
      pipeline: mr.head_pipeline ? { status: mr.head_pipeline.status } : undefined,
    };
  }

  async listMRs(options: ListMROptions = {}): Promise<TrackedMR[]> {
    // GitLab MR state doesn't support 'all', filter to 'opened' | 'closed'
    const state = options.state === 'all' ? 'opened' : (options.state || 'opened');
    const mrs = await this.client.MergeRequests.all({
      projectId: this.projectId,
      state,
      perPage: options.perPage || 20,
    }) as any[];
    return mrs.map(mr => ({
      id: mr.iid,
      platform: 'gitlab' as const,
      title: mr.title as string,
      state: mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'opened' : 'closed',
      sourceBranch: mr.source_branch as string,
      targetBranch: mr.target_branch as string,
      url: mr.web_url as string,
      projectId: String(this.projectId),
    }));
  }

  async createMR(options: CreateMROptions): Promise<number> {
    const mr = await this.client.MergeRequests.create(
      this.projectId,
      options.sourceBranch,
      options.targetBranch,
      options.title,
      {
        description: options.description || '',
        labels: options.labels?.join(','),
        removeSourceBranch: true,
      }
    ) as any;
    return mr.iid;
  }

  async mergeMR(id: number, options: MergeMROptions = {}): Promise<void> {
    await this.client.MergeRequests.accept(this.projectId, id, {
      shouldRemoveSourceBranch: options.deleteSourceBranch ?? true,
      squash: options.squash ?? false,
      mergeCommitMessage: options.mergeCommitMessage,
    });
  }

  async approveMR(id: number, options: ApproveMROptions = {}): Promise<void> {
    await this.client.MergeRequestApprovals.approve(this.projectId, id, {
      sha: options.sha,
    });
  }

  async closeMR(id: number, options: CloseMROptions = {}): Promise<void> {
    await this.client.MergeRequests.edit(this.projectId, id, {
      state_event: 'close',
    });
    if (options.comment) {
      await this.addMRComment(id, options.comment);
    }
  }

  async reopenMR(id: number): Promise<void> {
    await this.client.MergeRequests.edit(this.projectId, id, {
      state_event: 'reopen',
    });
  }

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
    const marker = `${worktreePath}/.afk/artifacts.txt`;
    const { promises: fs } = await import('fs');

    let artifactUrls = '';
    try {
      const content = await fs.readFile(marker, 'utf-8');
      const paths = content.split('\n').map(p => p.trim()).filter(Boolean);

      for (const filepath of paths) {
        try {
          const filename = filepath.split('/').pop()!;
          const fileContent = await fs.readFile(filepath);
          const upload = await (this.client as any).Projects.upload(
            this.projectId,
            fileContent,
            { metadata: { filename } }
          ) as any;
          const url = upload.full_path ?? upload.url ?? '';
          if (url) {
            artifactUrls += `\n- ![${filename}](${url})`;
          }
        } catch {
          // best-effort: skip failed uploads
        }
      }
    } catch {
      // no artifacts file — no-op
    }

    if (artifactUrls) {
      return `## Verification Evidence${artifactUrls}\n`;
    }
    return '';
  }

  async updateLabels(iid: number, delta: LabelDelta): Promise<void> {
    const remove = [...new Set(delta.remove)];
    const add = [...new Set(delta.add.filter(label => !remove.includes(label)))];
    await this.updateLabelsBatch(iid, add, remove);
  }

  async addLabelsToIssue(iid: number, labels: string[]): Promise<void> {
    const issue = await this.getIssue(iid);
    const newLabels = [...new Set([...issue.labels, ...labels])];
    await this.updateIssue(iid, { labels: newLabels });
  }

  async updateLabelsBatch(iid: number, add: string[], remove: string[]): Promise<void> {
    await this.client.Issues.edit(this.projectId, iid, {
      add_labels: add.join(','),
      remove_labels: remove.join(','),
    });
  }

  async createLaunchComment(iid: number, info: {
    worktreePath: string;
    targetBranch: string;
    session: string;
    traceId: string;
    goalLines: number;
    goalPreview: string;
  }): Promise<void> {
    const body = [
      '<!-- afk-event: launch -->',
      '**🚀 AFK Session Started**',
      '',
      `- **Worktree:** \`${info.worktreePath}\``,
      `- **Target branch:** \`${info.targetBranch}\``,
      `- **Session:** \`${info.session}\``,
      `- **Trace:** \`${info.traceId}\``,
      '',
      `<details>`,
      `<summary>Goal (${info.goalLines} lines)</summary>`,
      '',
      '```',
      info.goalPreview,
      '```',
      '</details>',
      '',
      `**Attach:** \`tmux attach -t ${info.session}\``,
    ].join('\n');
    await this.addComment(iid, body);
  }

  async updateProgressComment(iid: number, info: {
    worktreePath: string;
    sha: string;
    shortMsg: string;
    acDone: number;
    acTotal: number;
    next: string;
  }): Promise<void> {
    const marker = `<!-- AFK-PROGRESS-${iid} -->`;
    const body = [
      `${marker}`,
      `**AFK Progress** | commit:\`${info.sha}\` | ${info.shortMsg} | AC: ${info.acDone}/${info.acTotal}`,
      '',
      `> Next: ${info.next}`,
    ].join('\n');

    try {
      const notes = await this.client.IssueNotes.all(this.projectId, iid, { perPage: 100 }) as any[];
      const existing = notes.find((n: any) => n.body.includes(marker));
      if (existing) {
        await this.client.IssueNotes.edit(this.projectId, iid, existing.id, body);
      } else {
        await this.addComment(iid, body);
      }
    } catch {
      await this.addComment(iid, body);
    }
  }

  async getWorktreeSHA(worktreePath: string): Promise<string> {
    const git = simpleGit(worktreePath);
    return git.revparse('HEAD');
  }

  async addMRComment(mrIid: number, body: string, opts: { resolvable?: boolean } = {}): Promise<void> {
    await this.client.MergeRequestNotes.create(this.projectId, mrIid, body, {
      resolvable: opts.resolvable ?? false,
    });
  }

  async getMRPipelineStatus(mrIid: number): Promise<string> {
    const mr = await this.client.MergeRequests.show(this.projectId, mrIid) as any;
    return mr.head_pipeline?.status ?? 'unknown';
  }

  // ============ Projects ============

  async listProjects(options: { page?: number; perPage?: number } = {}): Promise<Project[]> {
    const items = await this.client.Projects.all({
      membership: true,
      page: options.page || 1,
      perPage: options.perPage || 20,
    }) as any[];
    return items.map(project => ({
      id: project.id,
      platform: 'gitlab' as const,
      name: project.name,
      path_with_namespace: project.path_with_namespace,
      description: project.description || undefined,
      default_branch: project.default_branch,
      namespace: { name: project.namespace?.name || '' },
      last_activity_at: project.last_activity_at,
      web_url: project.web_url,
    }));
  }

  async getBranches(projectId: number): Promise<Branch[]> {
    const branches = await this.client.Branches.all(projectId as string | number) as any[];
    return branches.map(b => ({
      name: b.name,
      commit: b.commit?.id?.substring(0, 8) || '',
      commit_title: b.commit?.title || '',
      author: b.commit?.author_name || '',
      committed_date: b.commit?.committed_date || '',
      protected: b.protected || false,
    }));
  }

  async getTags(projectId: number): Promise<Tag[]> {
    const tags = await this.client.Tags.all(projectId as string | number, { perPage: 10 }) as any[];
    return tags.map(t => ({
      name: t.name,
      commit: t.commit?.id?.substring(0, 8) || '',
      commit_author: t.commit?.author_name || '',
      commit_date: t.commit?.committed_date || '',
      message: t.message || '',
    }));
  }

  async getRecentCommits(projectId: number, perPage: number = 5): Promise<Commit[]> {
    const commits = await this.client.Commits.all(projectId as string | number, { perPage }) as any[];
    return commits.map(c => ({
      id: c.id?.substring(0, 8) || '',
      title: c.title || '',
      author: c.author_name || '',
      committed_date: c.committed_date || '',
    }));
  }
}
