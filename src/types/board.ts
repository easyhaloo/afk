export interface Task {
  iid: number;
  title: string;
  branch?: string;
  session?: string;
  status: 'active' | 'pending' | 'completed';
  progress?: string;
  startedAt?: Date;
  worktree?: string;
  platform?: 'github' | 'gitlab';
}

export interface TmuxSession {
  name: string;
  window: string;
  dir: string;
  status?: string;
  created?: string;
}

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
