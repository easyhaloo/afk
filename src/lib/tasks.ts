import { Task } from '../types/dashboard';
import { SessionService } from './sessions';
import type { Platform } from './core/tracker/types';

export class TaskService {
  private sessionService: SessionService;

  constructor() {
    this.sessionService = new SessionService();
  }

  /**
   * Decode session name to extract platform, project, and issue ID
   * Format: afk-gh-{repo}-{id} or afk-gl-{project}-{id}
   */
  decodeSession(sessionName: string): { platform: Platform; projectId: string; issueId: number } | null {
    const ghMatch = sessionName.match(/^afk-gh-([^-]+-[^-]+)-(\d+)$/);
    if (ghMatch) {
      return {
        platform: 'github',
        projectId: ghMatch[1],
        issueId: parseInt(ghMatch[2], 10),
      };
    }

    const glMatch = sessionName.match(/^afk-gl-(.+)-(\d+)$/);
    if (glMatch) {
      return {
        platform: 'gitlab',
        projectId: glMatch[1],
        issueId: parseInt(glMatch[2], 10),
      };
    }

    return null;
  }

  /**
   * Encode session name from platform, project, and issue ID
   */
  encodeSession(platform: Platform, projectId: string, issueId: number): string {
    const prefix = platform === 'github' ? 'afk-gh' : 'afk-gl';
    // GitHub: owner/repo → owner-repo
    const sanitized = projectId.replace(/\//g, '-');
    return `${prefix}-${sanitized}-${issueId}`;
  }

  async listTasks(): Promise<Task[]> {
    const sessions = await this.sessionService.listSessions();

    // Derive tasks from tmux sessions
    // Sessions starting with "afk-gh-" or "afk-gl-" are task sessions
    return sessions
      .filter(s => s.name.startsWith('afk-gh-') || s.name.startsWith('afk-gl-') || s.name.startsWith('issue-') || s.name.startsWith('task-'))
      .map(s => {
        const decoded = this.decodeSession(s.name);
        if (decoded) {
          return {
            iid: decoded.issueId,
            title: `Issue #${decoded.issueId}`,
            branch: decoded.projectId,
            session: s.name,
            status: 'active' as const,
            progress: '0%',
            startedAt: s.created ? new Date(parseInt(s.created) * 1000) : undefined,
            platform: decoded.platform,
          };
        }

        // Legacy format (issue-* / task-*)
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
      platform: options.platform,
    };
  }

  /**
   * Launch autonomous implementation via afk workflow launch.
   * Runs in background using setsid — does NOT block.
   * The tmux session is created and the claude agent is started inside it.
   */
  async launch(iid: number, sessionName: string, platform?: Platform): Promise<void> {
    const { spawn } = await import('child_process');
    const args = [
      'node',
      require.resolve('../index.js'),
      'workflow', 'launch',
      '--iid', String(iid),
      '--session', sessionName,
    ];
    if (platform) {
      args.push('--platform', platform);
    }
    // Use setsid to fully detach — dashboard process exits immediately.
    spawn('setsid', args, {
      stdio: 'ignore',
      detached: true,
      cwd: process.cwd(),
    }).unref();
  }
}
