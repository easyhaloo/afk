import { Task } from '../../../types/board';
import { TaskRuntimeManager, type ActiveTaskRuntimeRecord } from '../../../lib/runtime/task-runtime';
import { createGitLabClient } from '../../../lib/client-factory';
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
  };
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

export async function fetchProjects(options: { page?: number; perPage?: number } = {}): Promise<{ projects: Project[]; hasMore: boolean }> {
  // Always fetch all GitLab projects (unaffected by current git remote)
  // This allows viewing all accessible projects even when running from a GitHub repo
  try {
    return await fetchGitLabProjects(options);
  } catch (error) {
    fileLogger.error({ err: error }, 'failed to fetch GitLab projects');
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
