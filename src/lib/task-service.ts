import { Task } from '../types/dashboard';
import { SessionService } from './session-service';

export class TaskService {
  private sessionService: SessionService;

  constructor() {
    this.sessionService = new SessionService();
  }

  async listTasks(): Promise<Task[]> {
    const sessions = await this.sessionService.listSessions();

    // Derive tasks from tmux sessions
    // Sessions starting with "issue-" are task sessions
    return sessions
      .filter(s => s.name.startsWith('issue-') || s.name.startsWith('task-'))
      .map(s => {
        const parts = s.name.split('-');
        const iid = parseInt(parts[1]) || 0;
        return {
          iid,
          title: `Issue #${iid}`,
          branch: parts.slice(2).join('-') || 'main',
          session: s.name,
          status: 'active' as const,
          progress: '0%',
          startedAt: s.created ? new Date(parseInt(s.created) * 1000) : undefined,
        };
      });
  }

  async createTaskFromIssue(issue: any, options: any): Promise<Task> {
    // This would create a new tmux session for the issue
    // For now, return a task object
    return {
      iid: issue.iid,
      title: issue.title,
      branch: options.branch,
      session: options.session,
      status: 'pending',
      progress: '0%',
    };
  }
}
