import { Gitlab } from '@gitbeaker/node';
import { Issue } from '../types/dashboard';
import { applyGlabConfig } from './glab-config';

export class IssueService {
  private client: InstanceType<typeof Gitlab> | null = null;
  private projectId: string | number | null = null;

  constructor(_url?: string, token?: string, projectId?: string | number) {
    const cfg = token ? { host: process.env.GITLAB_URL || '', token } : applyGlabConfig();
    if (cfg) {
      this.client = new Gitlab({ host: cfg.host, token: cfg.token });
    }
    const pid = projectId || process.env.GITLAB_PROJECT_ID;
    if (pid) this.projectId = pid;
  }

  async listIssues(projectId?: string | number, page = 1, perPage = 20): Promise<{ issues: Issue[]; hasMore: boolean }> {
    if (!this.client) {
      return { issues: [], hasMore: false };
    }

    const targetProjectId = projectId || this.projectId;

    try {
      const params: Record<string, unknown> = { state: 'opened', page, perPage };
      // When no projectId is specified anywhere, omit the filter so GitLab
      // returns issues across all accessible projects. This makes the issue
      // view usable even when GITLAB_PROJECT_ID is not configured.
      if (targetProjectId) params.projectId = targetProjectId;

      const items = await this.client.Issues.all(params) as any[];

      return {
        issues: items.map(issue => ({
          iid: issue.iid as number,
          title: issue.title as string,
          description: (issue.description || '') as string,
          labels: (issue.labels || []) as string[],
          state: issue.state as string,
          web_url: issue.web_url as string,
        })),
        hasMore: items.length === perPage,
      };
    } catch (error) {
      console.error('Failed to list issues:', error);
      return { issues: [], hasMore: false };
    }
  }

  async getIssue(projectId: string | number, iid: number): Promise<Issue | null> {
    if (!this.client) {
      return null;
    }

    try {
      const issue = await this.client.Issues.show(projectId, iid);
      return {
        iid: issue.iid,
        title: issue.title,
        description: issue.description || '',
        labels: issue.labels as string[],
        state: issue.state,
        web_url: issue.web_url,
      };
    } catch (error) {
      console.error('Failed to get issue:', error);
      return null;
    }
  }
}
