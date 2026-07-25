import { Gitlab } from '@gitbeaker/node';
import { Project } from '../types/dashboard';
import { getGlabToken } from './glab-config';

export type { Project };

export class ProjectService {
  private client: InstanceType<typeof Gitlab> | null = null;

  constructor() {
    const gitlabUrl = process.env.GITLAB_URL;
    const gitlabToken = process.env.GITLAB_TOKEN;

    // Fallback to glab config
    let finalUrl = gitlabUrl;
    let finalToken = gitlabToken;
    if (!finalToken) {
      const glab = getGlabToken(finalUrl);
      if (glab) {
        finalUrl = finalUrl || (glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`);
        finalToken = glab.token;
      }
    }

    if (finalToken) {
      this.client = new Gitlab({
        host: finalUrl,
        token: finalToken,
      });
    }
  }

  async listProjects(): Promise<Project[]> {
    if (!this.client) {
      return [];
    }

    try {
      const projects = await this.client.Projects.all({
        membership: true,
        perPage: 50,
      });

      return (projects as any[]).map(project => ({
        id: project.id as number,
        name: project.name as string,
        path_with_namespace: project.path_with_namespace as string,
        description: (project.description || '') as string,
        default_branch: project.default_branch as string,
        namespace: { name: project.namespace?.name || '' },
        last_activity_at: project.last_activity_at as string,
        web_url: project.web_url as string,
      }));
    } catch (error) {
      console.error('Failed to list projects:', error);
      return [];
    }
  }
}
