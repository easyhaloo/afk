import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { glob } from 'glob';

import { directoryBytes, DependencyPool } from '../../infrastructure/git/dependency-pool.js';
import { RepositoryLeases } from '../../infrastructure/git/repository-lease.js';
import { RepositoryStore } from '../../infrastructure/git/repository-store.js';
import { executionWorkspacePath, resolveWorkspaceRoot, workspaceStateDirectory } from '../../infrastructure/workspace.js';
import { TaskRuntimeManager } from '../runtime/task-runtime.js';
import { readExecutionManifest } from './execution-manifest.js';

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ReclaimWorkspacesOptions {
  /** Workspace cache root. Defaults to `~/.loop-workspace`. */
  root?: string;
  /** Heartbeat age beyond which every record of a workspace counts as dead. */
  graceMs?: number;
  /** Explicit manifest paths. Defaults to scanning the workspace data area. */
  manifests?: string[];
  manager?: TaskRuntimeManager;
  leases?: Pick<RepositoryLeases, 'run'>;
  pool?: DependencyPool;
  store?: RepositoryStore;
  now?: Date;
}

export interface ReclaimedWorkspace {
  workItemId: string;
  path: string;
  bytes: number;
  capturedDependencies: string[];
}

export interface SkippedWorkspace {
  workItemId: string;
  path?: string;
  reason: string;
}

export interface WorkspaceReclamationReport {
  reclaimed: ReclaimedWorkspace[];
  skipped: SkippedWorkspace[];
  diagnostics: string[];
}

/**
 * Converge crashed or finished runs to the state the workflow's `finally`
 * chain would have produced (ADR-0038): capture installable dependencies into
 * the pool, release the checkout, remove managed worktrees, delete the
 * workspace directory, and terminate the attributed runtime records.
 *
 * The decision uses only cheap existing metadata — runtime records, execution
 * manifests, repository leases — and never touches a workspace whose run may
 * still be alive. Every workspace needs a valid manifest; legacy `unverified`
 * directories are reported and skipped.
 */
export async function reclaimWorkspaces(options: ReclaimWorkspacesOptions = {}): Promise<WorkspaceReclamationReport> {
  const root = resolve(options.root ?? resolveWorkspaceRoot());
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const cutoff = (options.now ?? new Date()).getTime() - graceMs;
  const manager = options.manager ?? new TaskRuntimeManager();
  const leases = options.leases ?? new RepositoryLeases();
  const pool = options.pool ?? new DependencyPool();
  const store = options.store ?? new RepositoryStore(join(root, 'repos'));
  const report: WorkspaceReclamationReport = { reclaimed: [], skipped: [], diagnostics: [] };

  const [activeRecords, archiveRecords] = await Promise.all([manager.store.listActive(), manager.store.listArchive()]);
  const records = [...activeRecords, ...archiveRecords];

  const manifestPaths = (options.manifests ?? (await glob(join(workspaceStateDirectory(), 'workspaces/*/execution-manifest.json'), { follow: false }).catch(() => [])))
    .map(path => resolve(path))
    .sort();
  for (const manifestPath of manifestPaths) {
    let workItemId = manifestPath;
    try {
      workItemId = JSON.parse(await fs.readFile(manifestPath, 'utf8')).workItemId;
      const manifest = await readExecutionManifest(manifestPath, workItemId);
      const workspace = executionWorkspacePath(manifest.workItemId, root);
      const location = relative(root, manifest.workspaceRoot);
      if (!location || location.startsWith(`..${sep}`) || location === '..' || isAbsolute(location) || resolve(manifest.workspaceRoot) !== workspace) {
        report.skipped.push({ workItemId: manifest.workItemId, path: manifest.workspaceRoot, reason: 'workspace root escapes the cache root' });
        continue;
      }
      if (!(await exists(workspace))) {
        report.skipped.push({ workItemId: manifest.workItemId, path: workspace, reason: 'workspace directory does not exist' });
        continue;
      }
      const keys = manifest.repositories.map(repository => `${repository.platform}:${repository.projectKey}`);
      const attributed = records.filter(record => {
        if (!record.workspace) return false;
        const recordLocation = relative(workspace, resolve(record.workspace));
        return recordLocation === '' || (!recordLocation.startsWith(`..${sep}`) && recordLocation !== '..' && !isAbsolute(recordLocation));
      });
      const alive = attributed.find(record => Date.parse(record.heartbeatAt) > cutoff);
      if (alive) {
        report.skipped.push({ workItemId: manifest.workItemId, path: workspace, reason: `runtime record ${alive.runId} heartbeated within the grace period` });
        continue;
      }
      const bytes = await directoryBytes(workspace);
      const capturedDependencies: string[] = [];
      try {
        // Acquiring the lease proves no live competitor and, through the
        // dead-owner recovery policy, clears expired claims of crashed runs.
        await leases.run(keys, async () => {
          for (const repository of manifest.repositories) {
            try {
              if (await pool.capture(repository.repoRoot)) capturedDependencies.push(repository.repoRoot);
              await pool.release(repository.repoRoot);
            } catch (error) {
              report.diagnostics.push(`${repository.repoRoot}: dependency reclaim failed: ${String(error)}`);
            }
            try { await store.removeCheckout(repository.repoRoot); } catch { /* independent clones are removed with the workspace */ }
          }
          await fs.rm(workspace, { recursive: true, force: true });
          for (const record of attributed.filter(entry => activeRecords.some(active => active.runId === entry.runId))) {
            await manager.store.finish(record.runId, { status: 'failed', errorSummary: 'workspace reclaimed after the run stopped heartbeating (ADR-0038)' })
              .catch(error => report.diagnostics.push(`${record.runId}: runtime record termination failed: ${String(error)}`));
          }
        });
      } catch (error) {
        report.skipped.push({ workItemId: manifest.workItemId, path: workspace, reason: `repository lease could not be acquired: ${String(error)}` });
        continue;
      }
      await pool.prune(nowFor(options));
      report.reclaimed.push({ workItemId: manifest.workItemId, path: workspace, bytes, capturedDependencies });
    } catch (error) {
      report.skipped.push({ workItemId, path: manifestPath, reason: `manifest evaluation failed: ${String(error)}` });
    }
  }
  return report;
}

function nowFor(options: ReclaimWorkspacesOptions): number {
  return (options.now ?? new Date()).getTime();
}

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
}
