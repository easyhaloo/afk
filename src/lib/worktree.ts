import { simpleGit, SimpleGit } from 'simple-git';
import { promises as fs } from 'fs';
import { join } from 'path';

export interface Worktree {
  iid: number;
  path: string;
  branch: string;
  sessionId?: string;
  createdAt: Date;
  status: 'active' | 'completed' | 'failed';
}

export interface WorktreeState {
  worktrees: Record<number, Worktree>;
}

const STATE_FILE = '.afk/worktrees.json';

/**
 * Git worktree manager with state tracking
 */
export class WorktreeManager {
  private git: SimpleGit;
  private stateFilePath: string;

  constructor(repoPath: string = process.cwd()) {
    this.git = simpleGit(repoPath);
    this.stateFilePath = join(repoPath, STATE_FILE);
  }

  /**
   * Create new worktree for issue
   */
  async create(iid: number, baseBranch: string, baseDir?: string): Promise<Worktree> {
    const branch = `afk-issue-${iid}`;
    const worktreeDir = baseDir || '/tmp/afk-worktrees';
    const path = join(worktreeDir, `issue-${iid}`);

    // Ensure base directory exists
    await fs.mkdir(worktreeDir, { recursive: true });

    // Create worktree
    await this.git.raw(['worktree', 'add', '-b', branch, path, baseBranch]);

    const worktree: Worktree = {
      iid,
      path,
      branch,
      createdAt: new Date(),
      status: 'active',
    };

    await this.saveWorktree(worktree);
    return worktree;
  }

  /**
   * Get worktree by IID
   */
  async get(iid: number): Promise<Worktree | null> {
    const state = await this.loadState();
    return state.worktrees[iid] || null;
  }

  /**
   * List all worktrees
   */
  async list(): Promise<Worktree[]> {
    const state = await this.loadState();
    return Object.values(state.worktrees);
  }

  /**
   * Update worktree status
   */
  async updateStatus(iid: number, status: Worktree['status']): Promise<void> {
    const state = await this.loadState();
    if (state.worktrees[iid]) {
      state.worktrees[iid].status = status;
      await this.saveState(state);
    }
  }

  /**
   * Cleanup worktree
   */
  async cleanup(iid: number, force: boolean = false): Promise<void> {
    const worktree = await this.get(iid);
    if (!worktree) {
      throw new Error(`Worktree for issue #${iid} not found`);
    }

    // Check for uncommitted changes if not force
    if (!force) {
      const gitInWorktree = simpleGit(worktree.path);
      const status = await gitInWorktree.status();

      if (status.files.length > 0) {
        throw new Error(
          `Worktree has uncommitted changes. Use --force to discard them.\n` +
          `Changed files:\n${status.files.map(f => `  ${f.path}`).join('\n')}`
        );
      }
    }

    // Remove worktree
    await this.git.raw(['worktree', 'remove', force ? '--force' : '', worktree.path].filter(Boolean));

    // Remove from state
    const state = await this.loadState();
    delete state.worktrees[iid];
    await this.saveState(state);
  }

  /**
   * List orphaned worktrees (no matching tmux session)
   */
  async listOrphaned(): Promise<Worktree[]> {
    const worktrees = await this.list();
    const orphaned: Worktree[] = [];

    for (const wt of worktrees) {
      if (wt.status === 'active' && wt.sessionId) {
        // Check if tmux session exists
        try {
          const { spawn } = await import('child_process');
          const proc = spawn('tmux', ['has-session', '-t', wt.sessionId], { stdio: 'pipe' });
          await new Promise((resolve, reject) => {
            proc.on('close', (code) => {
              if (code !== 0) {
                orphaned.push(wt);
              }
              resolve(code);
            });
            proc.on('error', reject);
          });
        } catch {
          orphaned.push(wt);
        }
      }
    }

    return orphaned;
  }

  /**
   * Prune all orphaned worktrees
   */
  async prune(dryRun: boolean = false): Promise<number> {
    const orphaned = await this.listOrphaned();

    if (dryRun) {
      return orphaned.length;
    }

    for (const wt of orphaned) {
      try {
        await this.cleanup(wt.iid, true);
      } catch (error) {
        console.error(`Failed to cleanup worktree ${wt.iid}:`, error);
      }
    }

    return orphaned.length;
  }

  /**
   * Save worktree to state
   */
  private async saveWorktree(worktree: Worktree): Promise<void> {
    const state = await this.loadState();
    state.worktrees[worktree.iid] = worktree;
    await this.saveState(state);
  }

  /**
   * Load state from file
   */
  private async loadState(): Promise<WorktreeState> {
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const data = JSON.parse(content);

      // Convert date strings back to Date objects
      Object.values(data.worktrees).forEach((wt: any) => {
        wt.createdAt = new Date(wt.createdAt);
      });

      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { worktrees: {} };
      }
      throw error;
    }
  }

  /**
   * Save state to file
   */
  private async saveState(state: WorktreeState): Promise<void> {
    const dir = join(this.stateFilePath, '..');
    await fs.mkdir(dir, { recursive: true });

    const content = JSON.stringify(state, null, 2);
    await fs.writeFile(this.stateFilePath, content, 'utf-8');
  }
}
