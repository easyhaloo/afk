import { lstat, mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { executionWorkspacePath, resolveWorkspaceRoot } from '../../infrastructure/workspace.js';
import { DependencyPool } from '../../infrastructure/git/dependency-pool.js';
import { RepositoryStore } from '../../infrastructure/git/repository-store.js';
import { TaskRuntimeManager, TaskRuntimeStore } from '../runtime/task-runtime.js';
import { reclaimWorkspaces } from './workspace-gc.js';

const NOW = new Date('2026-11-12T12:00:00Z');
const WORK_ITEM_ID = 'github:gc-test/api#941';

function record(workspace: string, heartbeatAt: string) {
  return {
    runId: 'gc-test-run',
    backlogId: '941',
    workspace,
    providerRef: 'github:gc-test/api#941',
    phase: 'implementing' as const,
    status: 'running' as const,
    sandboxProvider: 'local',
    executionMode: 'batch' as const,
    agentProvider: 'claude-code',
    startedAt: heartbeatAt,
    heartbeatAt,
  };
}

describe('reclaimWorkspaces', () => {
  it('reclaims a stale workspace, pools its dependencies, and terminates the runtime record', async () => {
    const root = resolveWorkspaceRoot();
    const temporary = await mkdtemp(join(tmpdir(), 'afk-gc-'));
    const workspace = executionWorkspacePath(WORK_ITEM_ID);
    const checkout = join(workspace, 'repositories/api');
    const runtimeRoot = join(temporary, 'runtime');
    const poolRoot = join(temporary, 'deps');
    const manifestPath = join(temporary, 'execution-manifest.json');
    try {
      // A leaked checkout: git repo with an untracked, installed node_modules.
      await mkdir(checkout, { recursive: true });
      const git = simpleGit(checkout);
      await git.init();
      await git.addConfig('user.email', 'gc@test');
      await git.addConfig('user.name', 'gc');
      await writeFile(join(checkout, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await git.add('.');
      await git.commit('base');
      await mkdir(join(checkout, 'node_modules/left-pad'), { recursive: true });
      await writeFile(join(checkout, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, workItemId: WORK_ITEM_ID, providerBacklogId: '941',
        tracker: { platform: 'github', projectKey: 'gc-test/api' }, workingBranch: 'afk/941', repositories: [{
          platform: 'github', projectKey: 'gc-test/api', name: 'api', checkoutPath: 'repositories/api',
          baseBranch: 'main', workingBranch: 'afk/941', primary: true,
        }] }));

      const manager = new TaskRuntimeManager(new TaskRuntimeStore(runtimeRoot));
      const staleHeartbeat = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      await manager.start(record(workspace, staleHeartbeat));

      const report = await reclaimWorkspaces({
        manifests: [manifestPath],
        manager,
        leases: { active: async () => false } as never,
        pool: new DependencyPool(poolRoot),
        store: new RepositoryStore(join(root, 'repos')),
        now: NOW,
      });

      expect(report.diagnostics).toEqual([]);
      expect(report.skipped).toEqual([]);
      expect(report.reclaimed).toHaveLength(1);
      expect(report.reclaimed[0]).toMatchObject({ workItemId: WORK_ITEM_ID, path: workspace, capturedDependencies: [checkout] });
      expect(report.reclaimed[0].bytes).toBeGreaterThan(0);
      // The workspace and its node_modules are gone; the installation survived in the pool.
      expect(await lstat(workspace).then(() => true, () => false)).toBe(false);
      const pooled = await readdir(poolRoot).catch(() => []);
      expect(pooled.filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
      // The stale active record was terminated into the archive.
      expect(await manager.store.getActive('gc-test-run')).toBeUndefined();
      const archived = await manager.store.listArchive();
      expect(archived[0]).toMatchObject({ runId: 'gc-test-run', status: 'failed' });
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps workspaces with fresh heartbeats, active leases, or unusable manifests', async () => {
    const root = resolveWorkspaceRoot();
    const temporary = await mkdtemp(join(tmpdir(), 'afk-gc-skip-'));
    const workspace = executionWorkspacePath(WORK_ITEM_ID);
    const manifestPath = join(temporary, 'execution-manifest.json');
    try {
      await mkdir(join(workspace, 'repositories/api'), { recursive: true });
      await writeFile(join(workspace, 'repositories/api/evidence.txt'), 'retained evidence');
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, workItemId: WORK_ITEM_ID, providerBacklogId: '941',
        tracker: { platform: 'github', projectKey: 'gc-test/api' }, workingBranch: 'afk/941', repositories: [{
          platform: 'github', projectKey: 'gc-test/api', name: 'api', checkoutPath: 'repositories/api',
          baseBranch: 'main', workingBranch: 'afk/941', primary: true,
        }] }));

      const manager = new TaskRuntimeManager(new TaskRuntimeStore(join(temporary, 'runtime')));
      const freshHeartbeat = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      await manager.start(record(workspace, freshHeartbeat));

      const fresh = await reclaimWorkspaces({
        manifests: [manifestPath], manager,
        leases: { active: async () => false } as never,
        pool: new DependencyPool(join(temporary, 'deps')),
        store: new RepositoryStore(join(root, 'repos')), now: NOW,
      });
      expect(fresh.reclaimed).toEqual([]);
      expect(fresh.skipped[0]?.reason).toContain('heartbeated within the grace period');

      const leased = await reclaimWorkspaces({
        manifests: [manifestPath], manager,
        leases: { active: async () => true } as never,
        pool: new DependencyPool(join(temporary, 'deps')),
        store: new RepositoryStore(join(root, 'repos')), now: NOW,
      });
      expect(leased.reclaimed).toEqual([]);
      expect(leased.skipped[0]?.reason).toBe('repository lease is active');

      await rm(manifestPath);
      const unusable = await reclaimWorkspaces({
        manifests: [manifestPath], manager,
        leases: { active: async () => false } as never,
        pool: new DependencyPool(join(temporary, 'deps')),
        store: new RepositoryStore(join(root, 'repos')), now: NOW,
      });
      expect(unusable.reclaimed).toEqual([]);
      expect(unusable.skipped[0]?.reason).toContain('manifest evaluation failed');
      // The workspace was never touched.
      expect(await readFile(join(workspace, 'repositories/api/evidence.txt'), 'utf8')).toBe('retained evidence');
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
