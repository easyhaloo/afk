import { Gitlab } from '@gitbeaker/node';
import { Project } from '../types/dashboard';
import { applyGlabConfig } from './glab-config';

export type { Project };

export class ProjectService {
  private client: InstanceType<typeof Gitlab> | null = null;

  constructor() {
    const cfg = applyGlabConfig();
    if (cfg) {
      this.client = new Gitlab({ host: cfg.host, token: cfg.token });
    }
  }

  async listProjects(page = 1, perPage = 20): Promise<{ projects: Project[]; hasMore: boolean }> {
    if (!this.client) {
      return { projects: [], hasMore: false };
    }

    try {
      const items = await this.client.Projects.all({
        membership: true,
        page,
        perPage,
      }) as any[];

      return {
        projects: items.map(project => ({
          id: project.id as number,
          name: project.name as string,
          path_with_namespace: project.path_with_namespace as string,
          description: (project.description || '') as string,
          default_branch: project.default_branch as string,
          namespace: { name: project.namespace?.name || '' },
          last_activity_at: project.last_activity_at as string,
          web_url: project.web_url as string,
        })),
        hasMore: items.length === perPage,
      };
    } catch (error) {
      console.error('Failed to list projects:', error);
      return { projects: [], hasMore: false };
    }
  }

  async getBranches(projectId: number): Promise<any[]> {
    if (!this.client) return [];
    try {
      const branches = await this.client.Branches.all(projectId as string | number);
      return (branches as any[]).map(b => ({
        name: b.name,
        commit: b.commit?.id?.substring(0, 8) || '',
        commit_title: b.commit?.title || '',
        author: b.commit?.author_name || '',
        committed_date: b.commit?.committed_date || '',
        protected: b.protected || false,
      }));
    } catch (error) {
      return [];
    }
  }

  async getTags(projectId: number): Promise<any[]> {
    if (!this.client) return [];
    try {
      const tags = await this.client.Tags.all(projectId as string | number, { perPage: 10 });
      return (tags as any[]).map(t => ({
        name: t.name,
        commit: t.commit?.id?.substring(0, 8) || '',
        commit_author: t.commit?.author_name || '',
        commit_date: t.commit?.committed_date || '',
        message: t.message || '',
      }));
    } catch (error) {
      return [];
    }
  }

  async getRecentCommits(projectId: number, perPage = 5): Promise<any[]> {
    if (!this.client) return [];
    try {
      const commits = await this.client.Commits.all(projectId as string | number, { perPage });
      return (commits as any[]).map(c => ({
        id: c.id?.substring(0, 8) || '',
        title: c.title || '',
        author: c.author_name || '',
        committed_date: c.committed_date || '',
      }));
    } catch (error) {
      return [];
    }
  }
}
