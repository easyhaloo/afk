import { Gitlab } from '@gitbeaker/node';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Detect GitLab project path from .git/config remote URL (synchronous).
 * Reads the git config file directly — no subprocess, no SDK async.
 */
export function detectGitLabProject(cwd?: string): string | null {
  try {
    const gitDir = cwd
      ? path.join(cwd, '.git')
      : path.join(process.cwd(), '.git');

    // Also support git worktree .git file (points to .git dir)
    const gitStat = fs.statSync(gitDir);
    const actualGitDir = gitStat.isFile()
      ? fs.readFileSync(gitDir, 'utf-8').trim().replace(/^git directory: /, '')
      : gitDir;

    const configPath = path.join(actualGitDir, 'config');
    const config = fs.readFileSync(configPath, 'utf-8');

    // Find [remote "origin"] section and read its url
    const remoteMatch = config.match(/\[remote "origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/m);
    if (!remoteMatch) return null;

    const url = remoteMatch[1].trim();
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

export interface GitLabConfig {
  url: string;
  token: string;
  projectId: string | number;
}

export interface Issue {
  iid: number;
  title: string;
  description: string;
  labels: string[];
  state: string;
  web_url: string;
}

export interface AC {
  text: string;
  items: string[];
}

/**
 * GitLab API client wrapper with retry and caching
 */
export class GitLabClient {
  private client: InstanceType<typeof Gitlab>;
  private projectId: string | number;

  constructor(config: GitLabConfig) {
    this.client = new Gitlab({
      host: config.url,
      token: config.token,
    });
    this.projectId = config.projectId;
  }

  /**
   * Get issue by IID
   */
  async getIssue(iid: number): Promise<Issue> {
    const issue = await this.client.Issues.show(this.projectId, iid);
    return {
      iid: issue.iid,
      title: issue.title,
      description: issue.description || '',
      labels: issue.labels as string[],
      state: issue.state,
      web_url: issue.web_url,
    };
  }

  /**
   * List issues with filters
   */
  async listIssues(options: {
    labels?: string[];
    state?: 'opened' | 'closed' | 'all';
    perPage?: number;
    projectId?: string | number;
  } = {}): Promise<Issue[]> {
    const targetProjectId = options.projectId || this.projectId;
    const issues = await this.client.Issues.all({
      projectId: targetProjectId,
      labels: options.labels?.join(','),
      state: options.state || 'opened',
      perPage: options.perPage || 20,
    });

    return (issues as any[]).map(issue => ({
      iid: issue.iid as number,
      title: issue.title as string,
      description: (issue.description || '') as string,
      labels: (issue.labels || []) as string[],
      state: issue.state as string,
      web_url: issue.web_url as string,
    }));
  }

  /**
   * Update issue labels
   */
  async updateLabels(iid: number, labels: string[]): Promise<void> {
    await this.client.Issues.edit(this.projectId, iid, {
      labels: labels.join(','),
    });
  }

  /**
   * Add label to issue
   */
  async addLabel(iid: number, label: string): Promise<void> {
    const issue = await this.getIssue(iid);
    const newLabels = [...new Set([...issue.labels, label])];
    await this.updateLabels(iid, newLabels);
  }

  /**
   * Remove label from issue
   */
  async removeLabel(iid: number, label: string): Promise<void> {
    const issue = await this.getIssue(iid);
    const newLabels = issue.labels.filter(l => l !== label);
    await this.updateLabels(iid, newLabels);
  }

  /**
   * Add comment to issue
   */
  async addComment(iid: number, body: string): Promise<void> {
    await this.client.IssueNotes.create(this.projectId, iid, body);
  }

  /**
   * Create a new issue
   */
  async createIssue(options: {
    title: string;
    description?: string;
    labels?: string[];
  }): Promise<number> {
    const issue = await this.client.Issues.create(this.projectId, {
      title: options.title,
      description: options.description || '',
      labels: options.labels?.join(',') || '',
    }) as any;
    return issue.iid;
  }

  /**
   * Update issue labels (add labels)
   */
  async addLabelsToIssue(iid: number, labels: string[]): Promise<void> {
    const issue = await this.getIssue(iid);
    const newLabels = [...new Set([...issue.labels, ...labels])];
    await this.client.Issues.edit(this.projectId, iid, {
      labels: newLabels.join(','),
    });
  }

  /**
   * Parse AC (Acceptance Criteria) from issue description
   */
  parseAC(description: string): AC | null {
    // Match ## AC or ## Acceptance Criteria section
    const acMatch = description.match(
      /##\s*(?:AC|Acceptance Criteria)\s*\n([\s\S]*?)(?=\n##|$)/i
    );

    if (!acMatch) {
      return null;
    }

    const acText = acMatch[1].trim();

    // Extract checkbox items: - [ ] item
    const items = [];
    const itemRegex = /^[-*]\s+\[\s*\]\s+(.+)$/gm;
    let match;

    while ((match = itemRegex.exec(acText)) !== null) {
      items.push(match[1].trim());
    }

    return {
      text: acText,
      items,
    };
  }

  /**
   * Get current retry count from issue labels (retry-count::N)
   */
  async getRetryCount(iid: number): Promise<number> {
    const issue = await this.getIssue(iid);
    const label = issue.labels.find(l => /^retry-count::\d+$/.test(l));
    if (!label) return 0;
    return parseInt(label.split('::')[1], 10);
  }

  /**
   * Increment retry count label on issue
   */
  async incrementRetryCount(iid: number): Promise<number> {
    const current = await this.getRetryCount(iid);
    const newCount = current + 1;
    const labels = (await this.getIssue(iid)).labels;
    // Remove old retry-count label if exists
    const withoutOld = labels.filter(l => !/^retry-count::/.test(l));
    await this.updateLabels(iid, [...withoutOld, `retry-count::${newCount}`]);
    return newCount;
  }

  /**
   * Detect target branch using 4-tier priority:
   * 1. explicit override (caller provides)
   * 2. base::prd-N label on issue → prd/N
   * 3. AFK_TARGET_BRANCH env var
   * 4. 'main'
   */
  async detectTargetBranch(iid: number, explicit?: string): Promise<string> {
    if (explicit) return explicit;

    const issue = await this.getIssue(iid);
    const prdLabel = issue.labels.find(l => /^base::prd-\d+$/.test(l));
    if (prdLabel) {
      return `prd/${prdLabel.replace('base::prd-', '')}`;
    }

    return process.env.AFK_TARGET_BRANCH || 'main';
  }

  /**
   * Post a structured launch event comment to the issue
   */
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

  /**
   * Update or create a progress comment on the issue
   */
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

    // Check if comment already exists
    const projEnc = String(this.projectId).replace('/', '%2F');
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

  /**
   * Get the current git SHA from a worktree
   */
  async getWorktreeSHA(worktreePath: string): Promise<string> {
    const { simpleGit } = await import('simple-git');
    return simpleGit(worktreePath).revparse('HEAD');
  }

  /**
   * Update labels: add and/or remove in one call
   */
  async updateLabelsBatch(iid: number, add: string[], remove: string[]): Promise<void> {
    await this.client.Issues.edit(this.projectId, iid, {
      add_labels: add.join(','),
      remove_labels: remove.join(','),
    });
  }

  /**
   * Add comment to MR
   */
  async addMRComment(mrIid: number, body: string, opts: { resolvable?: boolean } = {}): Promise<void> {
    await this.client.MergeRequestNotes.create(this.projectId, mrIid, body, {
      resolvable: opts.resolvable ?? false,
    });
  }

  /**
   * Get MR head pipeline status
   */
  async getMRPipelineStatus(mrIid: number): Promise<string> {
    const mr = await this.client.MergeRequests.show(this.projectId, mrIid) as any;
    return mr.head_pipeline?.status ?? 'unknown';
  }

  /**
   * Upload files from .afk/artifacts.txt and return markdown list of URLs
   */
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

  /**
   * Link two issues with a blocks / is_blocked_by relationship.
   * @param sourceIid - The issue that will block (or be blocked by) targetIid
   * @param targetIid - The issue that will be blocked (or block) sourceIid
   * @param linkType - 'blocks' means source blocks target; 'is_blocked_by' means source is blocked by target
   */
  async linkIssues(
    sourceIid: number,
    targetIid: number,
    linkType: 'blocks' | 'is_blocked_by' = 'blocks'
  ): Promise<void> {
    // GitLab API: link(projectId, issueIid, targetProjectId, targetIssueIId, options)
    await this.client.Issues.link(
      this.projectId,
      sourceIid,
      this.projectId,
      targetIid,
      { link_type: linkType }
    );
  }
}
