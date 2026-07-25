export interface Project {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string;
  default_branch?: string;
  namespace: { name: string };
  last_activity_at?: string;
  web_url?: string;
}

export class ProjectService {
  async listProjects(): Promise<Project[]> {
    return [];
  }
}
