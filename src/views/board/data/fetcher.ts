import { Task } from '../../../types/board';
import { TaskRuntimeManager, type ActiveTaskRuntimeRecord } from '../../../lib/runtime/task-runtime';
import { createGitHubClient, createGitLabClient } from '../../../lib/client-factory';
import { detectGitLabProject } from '../../../lib/core/tracker/detect';
import type { Project, Branch, Tag, Commit } from '../../../lib/core/tracker/types';
import { fileLogger } from '../../../lib/io';

const runtimeManager = new TaskRuntimeManager();

export async function fetchTasks(manager: TaskRuntimeManager = runtimeManager): Promise<{ active: Task[]; completed: Task[] }> {
  const data = await manager.listActive();
  return {
    active: data.map(toRuntimeTask),
    completed: [],
  };
}

/** Convert the local runtime projection into the narrow TUI task view model. */
export function toRuntimeTask(runtime: ActiveTaskRuntimeRecord): Task {
  return {
    iid: runtime.backlogId,
    runId: runtime.runId,
    title: runtime.title ?? `Backlog ${runtime.backlogId}`,
    phase: runtime.phase,
    executionMode: runtime.executionMode,
    sandboxProvider: runtime.sandboxProvider,
    agentProvider: runtime.agentProvider,
    status: runtime.status === 'stale' ? 'stale' : 'active',
    branch: runtime.branch,
    session: runtime.session,
    progress: runtime.progress,
    startedAt: new Date(runtime.startedAt),
    heartbeatAt: new Date(runtime.heartbeatAt),
    worktree: runtime.worktree,
    diagnosticPath: runtime.diagnosticPath,
    errorSummary: runtime.errorSummary,
    activities: runtime.activities?.map(activity => ({ ...activity, at: new Date(activity.at) })),
  };
}

/** Fetch all accessible GitLab projects through the GitLab project provider. */
export async function fetchGitLabProjects(options: { page?: number; perPage?: number } = {}): Promise<{ projects: Project[]; hasMore: boolean }> {
  let projectId: string | null = null;
  try {
    projectId = await detectGitLabProject();
  } catch {
    // No git remote — caller can pass --project or pick from the projects list
    projectId = null;
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

export async function fetchGitHubProjects(options: { page?: number; perPage?: number } = {}): Promise<{ projects: Project[]; hasMore: boolean }> {
  const client = await createGitHubClient();
  const projects = await client.listProjects({ page: options.page, perPage: options.perPage || 50 });
  return { projects, hasMore: projects.length === (options.perPage || 50) };
}

export function mergeProjects(projects: Project[]): Project[] {
  const unique = new Map<string, Project>();
  for (const project of projects) {
    const platform = project.platform || 'gitlab';
    unique.set(`${platform}:${project.path_with_namespace}`, { ...project, platform });
  }
  return [...unique.values()];
}

export function projectDetailKey(project: Project): string {
  return `${project.platform || 'gitlab'}:${project.id}`;
}

export async function fetchProjects(options: { page?: number; perPage?: number } = {}): Promise<{ projects: Project[]; hasMore: boolean }> {
  const [gitlab, github] = await Promise.all([
    fetchGitLabProjects(options).catch(error => {
      fileLogger.warn({ err: error }, 'GitLab projects unavailable');
      return { projects: [], hasMore: false };
    }),
    fetchGitHubProjects(options).catch(error => {
      fileLogger.warn({ err: error }, 'GitHub projects unavailable');
      return { projects: [], hasMore: false };
    }),
  ]);
  return {
    projects: mergeProjects([...gitlab.projects, ...github.projects]),
    hasMore: gitlab.hasMore || github.hasMore,
  };
}

export async function fetchProjectDetail(project: Project): Promise<{ branches: Branch[]; tags: Tag[]; commits: Commit[] }> {
  const client = project.platform === 'github'
    ? await createGitHubClient(project.path_with_namespace)
    : await createGitLabClient(String(project.id));
  const [branches, tags, commits] = await Promise.all([
    client.getBranches(project.id),
    client.getTags(project.id),
    client.getRecentCommits(project.id, 5),
  ]);
  return { branches, tags, commits };
}
