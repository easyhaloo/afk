import { Task } from '../types/board';
import { TmuxClient } from './core/tmux/tmux';
import { WorktreeManager } from './core/git';
import type { Platform } from './core/tracker/types.js';

export class TaskService {
  private tmux: TmuxClient;
  private worktreeManager: WorktreeManager;

  constructor() {
    this.tmux = new TmuxClient();
    this.worktreeManager = new WorktreeManager();
  }

  /**
   * Decode session name to extract platform, project, and issue ID
   * Formats:
   *   afk-gh-{iid}           — scheduler simplified (GitHub)
   *   afk-gl-{iid}           — scheduler simplified (GitLab)
   *   afk-gh-{owner-repo}-{id} — full format (GitHub)
   *   afk-gl-{project}-{id}  — full format (GitLab)
   */
  decodeSession(sessionName: string): { platform: Platform; projectId: string; issueId: number } | null {
    // Simplified format: afk-gh-{iid} or afk-gl-{iid}
    const simpleMatch = sessionName.match(/^afk-(gh|gl)-(\d+)$/);
    if (simpleMatch) {
      return {
        platform: simpleMatch[1] as Platform,
        projectId: 'unknown',
        issueId: parseInt(simpleMatch[2], 10),
      };
    }

    // Full format: afk-gh-{owner-repo}-{id} or afk-gl-{project}-{id}
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
    const sessions = await this.tmux.listSessions();
    const worktrees = await this.worktreeManager.list();
    const worktreeMap = new Map(worktrees.map(wt => [wt.iid, wt]));

    // Derive tasks from tmux sessions
    // Sessions starting with "afk-gh-" or "afk-gl-" are task sessions
    return sessions
      .filter(s => s.name.startsWith('afk-gh-') || s.name.startsWith('afk-gl-') || s.name.startsWith('issue-') || s.name.startsWith('task-'))
      .map(s => {
        const decoded = this.decodeSession(s.name);
        if (decoded) {
          const worktree = worktreeMap.get(decoded.issueId);
          return {
            iid: decoded.issueId,
            title: `Issue #${decoded.issueId}`,
            branch: worktree?.branch || decoded.projectId,
            session: s.name,
            status: 'active' as const,
            progress: '0%',
            startedAt: s.created ? new Date(parseInt(s.created) * 1000) : undefined,
            platform: decoded.platform,
            worktree: worktree?.path,
          };
        }

        // Legacy format (issue-* / task-*)
        const parts = s.name.split('-');
        const iid = parseInt(parts[1]) || 0;
        const worktree = worktreeMap.get(iid);
        return {
          iid,
          title: `Issue #${iid}`,
          branch: worktree?.branch || parts.slice(2).join('-') || 'main',
          session: s.name,
          status: 'active' as const,
          progress: '0%',
          startedAt: s.created ? new Date(parseInt(s.created) * 1000) : undefined,
          worktree: worktree?.path,
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
      worktree: options.worktree,
    };
  }

  /**
   * Launch autonomous implementation via afk workflow launch.
   * Runs in background using setsid — does NOT block.
   * The tmux session is created and the claude agent is started inside it.
   */
  async launch(iid: number, sessionName: string, platform?: Platform): Promise<void> {
    const { spawn } = await import('child_process');
    const { platform: osPlatform } = await import('os');
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
    // Use setsid on Linux to fully detach; on macOS the detached: true + stdio: ignore
    // is sufficient (launchd adopts the process).
    const o = { stdio: 'ignore' as const, detached: true as const, cwd: process.cwd() };
    if (osPlatform() === 'darwin') {
      spawn('node', args, o).unref();
    } else {
      spawn('setsid', ['node', ...args], o).unref();
    }
  }
}
