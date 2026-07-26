import { simpleGit, SimpleGit } from 'simple-git';
import { promises as fs } from 'fs';
import { join } from 'path';

export type MarkerStatus = 'crashed' | 'success';
export type WorktreeStatus = 'active' | 'completed' | 'failed';

export interface Worktree {
  iid: number;
  path: string;
  branch: string;
  sessionId?: string;
  createdAt: Date;
  status: WorktreeStatus;
  markerStatus?: MarkerStatus; // driven by .afk/CRASHED or .afk/SUCCESS marker files
}

export interface WorktreeState {
  worktrees: Record<number, Worktree>;
}

export interface CleanOptions {
  markerStatus?: MarkerStatus | 'all';
  olderThanDays?: number;
  stale?: boolean;   // inactive >7 days, no active session
  dryRun?: boolean;
}

const STATE_FILE = '.afk/worktrees.json';

/**
 * Git worktree manager with state tracking
 */
export class WorktreeManager {
  private git: SimpleGit;
  private stateFilePath: string;
  private _stateCache: WorktreeState | null = null;

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
   * List all worktrees (enriched with marker status from .afk/ files)
   */
  async list(): Promise<Worktree[]> {
    const state = await this.loadState();
    const worktrees = Object.values(state.worktrees);
    const enriched = await Promise.all(worktrees.map(wt => this.enrichWorktree(wt)));
    return enriched;
  }

  /**
   * Enrich worktree with runtime marker status (CRASHED/SUCCESS from .afk/ files)
   */
  private async enrichWorktree(wt: Worktree): Promise<Worktree> {
    const afkDir = join(wt.path, '.afk');
    try {
      await fs.stat(join(afkDir, 'CRASHED'));
      return { ...wt, markerStatus: 'crashed' };
    } catch (err: any) {
      if (err.code !== 'ENOENT') return wt;
    }
    try {
      await fs.stat(join(afkDir, 'SUCCESS'));
      return { ...wt, markerStatus: 'success' };
    } catch {
      // neither marker file present
    }
    return wt;
  }

  /**
   * Check if worktree has an active tmux session
   */
  private async hasActiveSession(wt: Worktree): Promise<boolean> {
    if (!wt.sessionId) return false;
    const { spawn } = await import('child_process');
    return new Promise(resolve => {
      const proc = spawn('tmux', ['has-session', '-t', wt.sessionId!], { stdio: 'pipe' });
      proc.on('close', code => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Get last activity timestamp (commit time or SUCCESS/CRASHED marker mtime)
   */
  private async lastActivityAt(wt: Worktree): Promise<Date> {
    const afkDir = join(wt.path, '.afk');
    try {
      const stat = await fs.stat(afkDir);
      return stat.mtime;
    } catch {
      // fallback to last commit
    }
    try {
      const git = simpleGit(wt.path);
      const log = await git.log({ n: 1, format: { date: 'absolute' } });
      return log.latest ? new Date(log.latest.date) : new Date(0);
    } catch {
      return new Date(0);
    }
  }

  /**
   * Clean worktrees by marker status and/or age.
   * Safe default: only cleans crashed/success when no flags are given.
   */
  async clean(options: CleanOptions = {}): Promise<{ deleted: number; skipped: number }> {
    const { markerStatus, olderThanDays, stale = false, dryRun = false } = options;
    const worktrees = await this.list();

    // Active session check — only needed when --all could fire
    const activeIids = markerStatus === 'all'
      ? new Set(
          (await Promise.all(worktrees.map(async wt => {
            return (await this.hasActiveSession(wt)) ? wt.iid : null;
          })))  
            .filter((iid): iid is number => iid !== null)
        )
      : new Set<number>();

    // Age computation — only when stale or --days is used
    const ageMap = new Map<number, number>();
    if (stale || olderThanDays) {
      const ages = await Promise.all(worktrees.map(async wt => ({
        iid: wt.iid,
        ms: Date.now() - (await this.lastActivityAt(wt)).getTime(),
      })));
      ages.forEach(({ iid, ms }) => ageMap.set(iid, ms));
    }

    let deleted = 0;
    let skipped = 0;

    for (const wt of worktrees) {
      // Active tmux sessions are always protected
      if (activeIids.has(wt.iid)) { skipped++; continue; }

      // Marker status filter
      if (markerStatus === 'all') {
        // protected above
      } else if (markerStatus) {
        if (wt.markerStatus !== markerStatus) { skipped++; continue; }
      } else if (!stale) {
        // No flags: safe default — only finished worktrees
        if (wt.markerStatus !== 'crashed' && wt.markerStatus !== 'success') { skipped++; continue; }
      }

      // Stale filter
      if (stale) {
        const ms = ageMap.get(wt.iid) ?? 0;
        if (ms < 7 * 86400 * 1000) { skipped++; continue; }
      }

      // Age filter
      if (olderThanDays) {
        const ms = ageMap.get(wt.iid) ?? 0;
        if (ms < olderThanDays * 86400 * 1000) { skipped++; continue; }
      }

      if (dryRun) {
        console.log(`  would remove: #${wt.iid} [${wt.markerStatus || wt.status}] ${wt.path}`);
        deleted++;
      } else {
        try {
          await this.cleanup(wt.iid, true);
          console.log(`  removed: #${wt.iid} [${wt.markerStatus || wt.status}] ${wt.path}`);
          deleted++;
        } catch (err) {
          console.error(`  failed: #${wt.iid}`, (err as Error).message);
          skipped++;
        }
      }
    }

    return { deleted, skipped };
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
    if (this._stateCache) return this._stateCache;
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const data = JSON.parse(content);
      Object.values(data.worktrees).forEach((wt: any) => {
        wt.createdAt = new Date(wt.createdAt);
      });
      this._stateCache = data;
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
    this._stateCache = null; // invalidate
  }
}
