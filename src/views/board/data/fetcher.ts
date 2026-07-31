import { Task, Issue, TmuxSession } from '../../../types/board';
import { TaskService } from '../../../lib/tasks';
import { TmuxClient } from '../../../lib/core/tmux/tmux';
import { createGitLabClient } from '../../../lib/client-factory';
import { detectGitLabProject } from '../../../lib/core/tracker/detect';
import type { TrackedIssue, Project, Branch, Tag, Commit } from '../../../lib/core/tracker/types';

const taskService = new TaskService();
const tmux = new TmuxClient();

/**
 * Convert TrackedIssue (platform-agnostic) to Issue (board format).
 */
function toIssue(t: TrackedIssue): Issue {
  return {
    iid: t.id,
    title: t.title,
    description: t.description,
    labels: t.labels,
    state: t.state,
    web_url: t.url,
  };
}

export async function fetchTasks(): Promise<{ active: Task[]; completed: Task[] }> {
  const data = await taskService.listTasks();
  return {
    active: data.filter(t => t.status === 'active' || t.status === 'pending'),
    completed: data.filter(t => t.status === 'completed'),
  };
}

export async function fetchSessions(): Promise<TmuxSession[]> {
  return tmux.listSessions();
}

/**
 * Fetch all accessible GitLab projects (unaffected by git remote).
 * Always uses GitLab with membership=true to get all projects user can access.
 */
export async function fetchGitLabProjects(options: { page?: number; perPage?: number } = {}): Promise<{ projects: Project[]; hasMore: boolean }> {
  let projectId: string | null = null;
  try {
    projectId = await detectGitLabProject();
  } catch {
    // No git remote, try env var
    projectId = process.env.GITLAB_PROJECT_ID || null;
  }

  // Try env token first, then glab CLI config
  let token = process.env.GITLAB_TOKEN;
  let url = process.env.GITLAB_URL || 'https://gitlab.com';

  if (!token) {
    const glab = await import('../../../lib/core/gitlab/glab-config').then(m => m.getGlabToken(url));
    if (glab) {
      token = glab.token;
      url = glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`;
    }
  }

  if (!token) {
    throw new Error('GITLAB_TOKEN environment variable or glab CLI authentication required');
  }

  // Use projectId if available, otherwise fallback to first accessible project
  const effectiveProjectId = projectId || 'glab';
  const client = new (await import('../../../lib/core/gitlab/index')).GitLabClient({
    url,
    token,
    projectId: effectiveProjectId,
  });

  const projects = await client.listProjects({ page: options.page, perPage: options.perPage || 50 });
  return { projects, hasMore: projects.length === (options.perPage || 50) };
}

/**
 * Fetch issues with priority:
 * 1. projectId provided: issues for that specific project
 * 2. git remote detected: issues for that platform's project
 * 3. no projectId + no detection: return empty (user should select a project)
 */
export async function fetchIssues(options: {
  projectId?: string | number | null;
  page?: number;
  perPage?: number;
  labels?: string[];
  state?: string;
} = {}): Promise<{ issues: Issue[]; hasMore: boolean }> {
  // Try env token first, then glab CLI config
  let token = process.env.GITLAB_TOKEN;
  let url = process.env.GITLAB_URL || 'https://gitlab.com';

  if (!token) {
    const glab = await import('../../../lib/core/gitlab/glab-config').then(m => m.getGlabToken(url));
    if (glab) {
      token = glab.token;
      url = glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`;
    }
  }

  if (!token) {
    return { issues: [], hasMore: false };
  }

  // Resolve projectId
  let projectId = options.projectId ? String(options.projectId) : null;
  if (!projectId) {
    try {
      projectId = await detectGitLabProject();
    } catch {
      projectId = process.env.GITLAB_PROJECT_ID || null;
    }
  }

  // If still no projectId, return empty (user needs to select a project)
  if (!projectId) {
    return { issues: [], hasMore: false };
  }

  const client = new (await import('../../../lib/core/gitlab/index')).GitLabClient({
    url,
    token,
    projectId,
  });

  const issues = await client.listIssues({
    labels: options.labels,
    state: options.state as 'opened' | 'closed' | 'all' || 'opened',
    perPage: options.perPage,
  });

  return {
    issues: issues.map(toIssue),
    hasMore: issues.length === (options.perPage || 20),
  };
}

export async function fetchProjects(options: { page?: number; perPage?: number } = {}): Promise<{ projects: Project[]; hasMore: boolean }> {
  // Always fetch all GitLab projects (unaffected by current git remote)
  // This allows viewing all accessible projects even when running from a GitHub repo
  try {
    return await fetchGitLabProjects(options);
  } catch (error) {
    console.error('Failed to fetch GitLab projects:', error);
    return { projects: [], hasMore: false };
  }
}

export async function fetchProjectDetail(projectId: number): Promise<{ branches: Branch[]; tags: Tag[]; commits: Commit[] }> {
  const client = await createGitLabClient();
  const [branches, tags, commits] = await Promise.all([
    client.getBranches(projectId),
    client.getTags(projectId),
    client.getRecentCommits(projectId, 5),
  ]);
  return { branches, tags, commits };
}

export async function killSession(sessionName: string): Promise<void> {
  return tmux.killSession(sessionName);
}

export async function createTaskFromIssue(issue: Issue, options: {
  branch: string;
  session: string;
  worktree: string;
}): Promise<Task> {
  return taskService.createTaskFromIssue(issue, options);
}

export async function launchTask(iid: number, sessionName: string): Promise<void> {
  return taskService.launch(iid, sessionName);
}
