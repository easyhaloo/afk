import { Task, Issue, Project, TmuxSession } from '../../../types/dashboard';
import { TaskService } from '../../../lib/tasks';
import { TmuxClient } from '../../../lib/core/tmux/tmux';
import { IssueService } from '../../../lib/issues';
import { ProjectService } from '../../../lib/projects';
import { createTrackerClient } from '../../../lib/client-factory';
import type { TrackedIssue } from '../../../lib/core/tracker/types';

const taskService = new TaskService();
const tmux = new TmuxClient();
const issueService = new IssueService();
const projectService = new ProjectService();

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
 * Falls back to IssueService (GitLab-only) if TrackerProvider is unavailable.
 */
export async function fetchIssues(options: {
  projectId?: string | number;
  page?: number;
  perPage?: number;
  labels?: string[];
  state?: string;
} = {}): Promise<{ issues: Issue[]; hasMore: boolean }> {
  try {
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
  } catch {
    // Fallback to IssueService (GitLab)
    const result = await issueService.listIssues(
      options.projectId,
      options.page || 1,
      options.perPage || 20,
    );
    return result;
  }
}

export async function fetchProjectDetail(projectId: number) {
  const [branches, tags, commits] = await Promise.all([
    projectService.getBranches(projectId),
    projectService.getTags(projectId),
    projectService.getRecentCommits(projectId),
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

// IssueService / ProjectService are used directly by useData for paginated calls.
export { issueService, projectService };
