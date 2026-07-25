import { Task, Issue, Project, TmuxSession } from '../../../types/dashboard';
import { TaskService } from '../../task-service';
import { SessionService } from '../../session-service';
import { IssueService } from '../../issue-service';
import { ProjectService } from '../../project-service';

const taskService = new TaskService();
const sessionService = new SessionService();
const issueService = new IssueService();
const projectService = new ProjectService();

export async function fetchTasks(): Promise<{ active: Task[]; completed: Task[] }> {
  const data = await taskService.listTasks();
  return {
    active: data.filter(t => t.status === 'active' || t.status === 'pending'),
    completed: data.filter(t => t.status === 'completed'),
  };
}

export async function fetchSessions(): Promise<TmuxSession[]> {
  return sessionService.listSessions();
}

export async function fetchIssues(projectId?: string | number): Promise<Issue[]> {
  return issueService.listIssues(projectId);
}

export async function fetchProjects(): Promise<Project[]> {
  return projectService.listProjects();
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
  return sessionService.killSession(sessionName);
}

export async function createTaskFromIssue(issue: Issue, options: {
  branch: string;
  session: string;
  worktree: string;
}): Promise<Task> {
  return taskService.createTaskFromIssue(issue, options);
}
