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
  markerStatus?: MarkerStatus;
}

export interface WorktreeState {
  worktrees: Record<number, Worktree>;
}

export interface CleanOptions {
  markerStatus?: MarkerStatus | 'all';
  olderThanDays?: number;
  stale?: boolean;
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

  async create(iid: number, baseBranch: string, baseDir?: string): Promise<Worktree> {
    const branch = `afk-issue-${iid}`;
    const worktreeDir = baseDir || join(process.cwd(), '.worktrees');
    const path = join(worktreeDir, `issue-${iid}`);
    await fs.mkdir(worktreeDir, { recursive: true });

    try {
      await this.git.raw(['worktree', 'add', '-b', branch, path, baseBranch]);
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('already exists') || msg.includes('的工作区')) {
        // Stale branch + worktree from a failed retry. Remove worktree first
        // (branch can't be deleted while worktree uses it), then delete branch.
        try { await this.git.raw(['worktree', 'remove', path, '--force']); } catch { /* ignore */ }
        try { await this.git.raw(['branch', '-D', branch]); } catch { /* ignore */ }
        await this.git.raw(['worktree', 'add', '-b', branch, path, baseBranch]);
      } else {
        throw err;
      }
    }

    const worktree: Worktree = { iid, path, branch, createdAt: new Date(), status: 'active' };
    await this.saveWorktree(worktree);
    return worktree;
  }

  async get(iid: number): Promise<Worktree | null> {
    const state = await this.loadState();
    return state.worktrees[iid] || null;
  }

  async list(): Promise<Worktree[]> {
    const state = await this.loadState();
    const worktrees = Object.values(state.worktrees);
    return Promise.all(worktrees.map(wt => this.enrichWorktree(wt)));
  }

  private async enrichWorktree(wt: Worktree): Promise<Worktree> {
    const afkDir = join(wt.path, '.afk');
    try { await fs.stat(join(afkDir, 'CRASHED')); return { ...wt, markerStatus: 'crashed' }; } catch {}
    try { await fs.stat(join(afkDir, 'SUCCESS')); return { ...wt, markerStatus: 'success' }; } catch {}
    return wt;
  }

  private async hasActiveSession(wt: Worktree): Promise<boolean> {
    if (!wt.sessionId) return false;
    const { spawn } = await import('child_process');
    return new Promise(resolve => {
      const proc = spawn('tmux', ['has-session', '-t', wt.sessionId!], { stdio: 'pipe' });
      proc.on('close', code => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  private async lastActivityAt(wt: Worktree): Promise<Date> {
    const afkDir = join(wt.path, '.afk');
    try { const stat = await fs.stat(afkDir); return stat.mtime; } catch {}
    try {
      const git = simpleGit(wt.path);
      const log = await git.log({ n: 1, format: { date: 'absolute' } });
      return log.latest ? new Date(log.latest.date) : new Date(0);
    } catch { return new Date(0); }
  }

  async clean(options: CleanOptions = {}): Promise<{ deleted: number; skipped: number }> {
    const { markerStatus, olderThanDays, stale = false, dryRun = false } = options;
    const worktrees = await this.list();

    const activeIids = new Set<number>();
    if (markerStatus === 'all') {
      for (const wt of worktrees) {
        if (await this.hasActiveSession(wt)) activeIids.add(wt.iid);
      }
    }

    const ageMap = new Map<number, number>();
    if (stale || olderThanDays) {
      for (const wt of worktrees) {
        ageMap.set(wt.iid, Date.now() - (await this.lastActivityAt(wt)).getTime());
      }
    }

    let deleted = 0, skipped = 0;
    for (const wt of worktrees) {
      if (activeIids.has(wt.iid)) { skipped++; continue; }
      if (markerStatus === 'all') {}
      else if (markerStatus) { if (wt.markerStatus !== markerStatus) { skipped++; continue; } }
      else if (!stale) { if (wt.markerStatus !== 'crashed' && wt.markerStatus !== 'success') { skipped++; continue; } }
      if (stale) { const ms = ageMap.get(wt.iid) ?? 0; if (ms < 7 * 86400 * 1000) { skipped++; continue; } }
      if (olderThanDays) { const ms = ageMap.get(wt.iid) ?? 0; if (ms < olderThanDays * 86400 * 1000) { skipped++; continue; } }
      if (dryRun) { console.log(`  would remove: #${wt.iid} [${wt.markerStatus || wt.status}] ${wt.path}`); deleted++; }
      else {
        try { await this.cleanup(wt.iid, true); console.log(`  removed: #${wt.iid} [${wt.markerStatus || wt.status}] ${wt.path}`); deleted++; }
        catch (err) { console.error(`  failed: #${wt.iid}`, (err as Error).message); skipped++; }
      }
    }
    return { deleted, skipped };
  }

  async updateStatus(iid: number, status: Worktree['status']): Promise<void> {
    const state = await this.loadState();
    if (state.worktrees[iid]) { state.worktrees[iid].status = status; await this.saveState(state); }
  }

  async cleanup(iid: number, force: boolean = false): Promise<void> {
    const worktree = await this.get(iid);
    if (!worktree) return; // Already cleaned up.
    if (!force) {
      const gitInWorktree = simpleGit(worktree.path);
      const status = await gitInWorktree.status();
      if (status.files.length > 0) throw new Error(`Worktree has uncommitted changes. Use --force.\n${status.files.map(f => `  ${f.path}`).join('\n')}`);
    }
    await this.git.raw(['worktree', 'remove', force ? '--force' : '', worktree.path].filter(Boolean));
    const state = await this.loadState();
    delete state.worktrees[iid];
    await this.saveState(state);
  }

  async listOrphaned(): Promise<Worktree[]> {
    const worktrees = await this.list();
    const orphaned: Worktree[] = [];
    for (const wt of worktrees) {
      if (wt.status === 'active' && wt.sessionId) {
        try {
          const { spawn } = await import('child_process');
          const proc = spawn('tmux', ['has-session', '-t', wt.sessionId], { stdio: 'pipe' });
          await new Promise((resolve, reject) => { proc.on('close', (code) => { if (code !== 0) orphaned.push(wt); resolve(code); }); proc.on('error', (err) => { orphaned.push(wt); resolve(err); }); });
        } catch { orphaned.push(wt); }
      }
    }
    return orphaned;
  }

  async prune(dryRun: boolean = false): Promise<number> {
    const orphaned = await this.listOrphaned();
    if (dryRun) return orphaned.length;
    for (const wt of orphaned) { try { await this.cleanup(wt.iid, true); } catch (error) { console.error(`Failed: ${wt.iid}`, error); } }
    return orphaned.length;
  }

  private async saveWorktree(worktree: Worktree): Promise<void> {
    const state = await this.loadState();
    state.worktrees[worktree.iid] = worktree;
    await this.saveState(state);
  }

  private async loadState(): Promise<WorktreeState> {
    if (this._stateCache) return this._stateCache;
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const data = JSON.parse(content);
      Object.values(data.worktrees).forEach((wt: any) => { wt.createdAt = new Date(wt.createdAt); });
      this._stateCache = data;
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { worktrees: {} };
      throw error;
    }
  }

  private async saveState(state: WorktreeState): Promise<void> {
    const dir = join(this.stateFilePath, '..');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
    this._stateCache = null;
  }
}
