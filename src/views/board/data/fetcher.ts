import { Task } from '../../../types/board';
import { TaskRuntimeManager, type ActiveTaskRuntimeRecord, type TaskRuntimeRecord } from '../../../application/runtime/task-runtime';
import type { BacklogItem } from '../../../domain/backlog';
import { createGitLabTracker } from '../../../application/tracker-provider-factory';
import { resolveGitLabProject } from '../../../infrastructure/tracker/resolver';
import type { Project, Branch, Tag, Commit } from '../../../domain/tracker/types';
import { fileLogger } from '../../../infrastructure/io/logger';
import { projectWorkItems } from './work-item-projection';

const runtimeManager = new TaskRuntimeManager();

export async function fetchTasks(
  manager: TaskRuntimeManager = runtimeManager,
  backlogs: readonly Pick<BacklogItem, 'id' | 'title' | 'state' | 'providerRef'>[] = [],
): Promise<{ active: Task[]; completed: Task[] }> {
  const [active, archive] = await Promise.all([manager.listActive(), manager.listArchive()]);
  const projections = projectWorkItems({ backlogs, active, archive, workspace: process.cwd() });
  const tasks = projections
    .filter((projection): projection is typeof projection & { runtime: TaskRuntimeRecord | ActiveTaskRuntimeRecord } => projection.runtime !== undefined)
    .map(projection => toRuntimeTask(projection.runtime, {
      backlogState: projection.backlogState,
      runStatus: projection.runStatus,
      title: projection.backlog?.title,
    }));
  return {
    active: tasks.filter(task => task.runStatus === 'running' || task.runStatus === 'stale'),
    completed: tasks.filter(task => task.runStatus !== 'running' && task.runStatus !== 'stale'),
  };
}

/** Convert the local runtime projection into the narrow TUI task view model. */
export function toRuntimeTask(
  runtime: TaskRuntimeRecord | ActiveTaskRuntimeRecord,
  context: Partial<Pick<Task, 'backlogState' | 'runStatus' | 'title'>> = {},
): Task {
  const runStatus = context.runStatus ?? (runtime.status === 'stale' ? 'stale' : runtime.status);
  return {
    backlogId: runtime.backlogId,
    iid: runtime.backlogId,
    runId: runtime.runId,
    title: context.title ?? runtime.title ?? `Backlog ${runtime.backlogId}`,
    phase: runtime.phase,
    executionMode: runtime.executionMode,
    sandboxProvider: runtime.sandboxProvider,
    agentProvider: runtime.agentProvider,
    status: runtime.status === 'stale' ? 'stale' : 'active',
    backlogState: context.backlogState,
    runStatus,
    activities: runtime.activities?.map(activity => ({ ...activity, at: new Date(activity.at) })),
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

export function mergeProjects(projects: Project[]): Project[] {
  const seen = new Set<string>();
  return projects.filter(project => {
    const key = `${(project as Project & { platform?: string }).platform ?? 'unknown'}:${project.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectDetailKey(project: Project & { platform?: string }): string {
  return `${project.platform ?? 'unknown'}:${project.id}`;
}

/**
 * Fetch all accessible GitLab projects (unaffected by git remote).
 * Always uses GitLab with membership=true to get all projects user can access.
 */
export async function fetchGitLabProjects(options: { page?: number; perPage?: number } = {}): Promise<{ projects: Project[]; hasMore: boolean }> {
  let projectId: string | null = null;
  try {
    projectId = await resolveGitLabProject();
  } catch {
    // No git remote — caller can pass --project or pick from the projects list
    projectId = null;
  }

  // Try env token first, then glab CLI config
  let token = process.env.GITLAB_TOKEN;
  let url = process.env.GITLAB_URL || 'https://gitlab.com';

  if (!token) {
    const glab = await import('../../../infrastructure/gitlab/glab-config').then(m => m.getGlabToken(url));
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
  const client = new (await import('../../../infrastructure/gitlab')).GitLabClient({
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
  const client = await createGitLabTracker();
  const [branches, tags, commits] = await Promise.all([
    client.getBranches(projectId),
    client.getTags(projectId),
    client.getRecentCommits(projectId, 5),
  ]);
  return { branches, tags, commits };
}
