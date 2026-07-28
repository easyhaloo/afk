import { Task, Issue, TmuxSession } from '../../../types/dashboard';
import { TaskService } from '../../../lib/tasks';
import { TmuxClient } from '../../../lib/core/tmux/tmux';
import { createTrackerClient } from '../../../lib/client-factory';
import type { TrackedIssue, Project, Branch, Tag, Commit } from '../../../lib/core/tracker/types';

const taskService = new TaskService();
const tmux = new TmuxClient();

/**
 * Convert TrackedIssue (platform-agnostic) to Issue (dashboard format).
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
 * Fetch issues using platform-agnostic TrackerProvider.
 */
export async function fetchIssues(options: {
  projectId?: string | number;
  page?: number;
  perPage?: number;
  labels?: string[];
  state?: string;
} = {}): Promise<{ issues: Issue[]; hasMore: boolean }> {
  const tracker = await createTrackerClient();
  const issues = await tracker.listIssues({
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
  const tracker = await createTrackerClient();
  const projects = await tracker.listProjects({ page: options.page, perPage: options.perPage || 50 });
  return { projects, hasMore: projects.length === (options.perPage || 50) };
}

export async function fetchProjectDetail(projectId: number): Promise<{ branches: Branch[]; tags: Tag[]; commits: Commit[] }> {
  const tracker = await createTrackerClient();
  const [branches, tags, commits] = await Promise.all([
    tracker.getBranches(projectId),
    tracker.getTags(projectId),
    tracker.getRecentCommits(projectId, 5),
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
