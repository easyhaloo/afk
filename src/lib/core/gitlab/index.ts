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
  AcceptanceCriteria,
  LinkType,
} from '../tracker/types';

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

  async linkIssues(sourceId: number, targetId: number, type: LinkType): Promise<void> {
    await this.client.Issues.link(
      this.projectId,
      sourceId,
      this.projectId,
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
}
