import { Task } from '../types/dashboard';
import { SessionService } from './sessions';

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
    return {
      iid: issue.iid,
      title: issue.title,
      branch: options.branch,
      session: options.session,
      status: 'pending',
      progress: '0%',
    };
  }

  /**
   * Launch autonomous implementation via afk workflow launch.
   * Runs in background using setsid — does NOT block.
   * The tmux session is created and the claude agent is started inside it.
   */
  async launch(iid: number, sessionName: string): Promise<void> {
    const { spawn } = await import('child_process');
    // Use setsid to fully detach — dashboard process exits immediately.
    spawn('setsid', [
      'node',
      require.resolve('../index.js'),  // afk CLI entry
      'workflow', 'launch',
      '--iid', String(iid),
      '--session', sessionName,
    ], {
      stdio: 'ignore',
      detached: true,
      cwd: process.cwd(),
    }).unref();
  }
}
