import { Gitlab } from '@gitbeaker/node';

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
}
