import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { executionWorkspacePath, resolveWorkspaceRoot, workspaceDataDirectory } from '../../infrastructure/workspace.js';
import { inspectWorkspaceDisk } from './workspace-disk.js';

describe('workspace disk inventory', () => {
  it('counts bare caches and gates workspace reclamation on live repository leases', async () => {
    const root = resolveWorkspaceRoot();
    const temporary = await mkdtemp(join(tmpdir(), 'afk-doctor-'));
    const workItemId = 'github:doctor-test/api#913';
    const workspace = executionWorkspacePath(workItemId);
    const bare = join(root, 'repos/doctor-test/api/bare.git');
    try {
      await mkdir(join(workspace, 'repositories/api'), { recursive: true });
      await writeFile(join(workspace, 'repositories/api/evidence.txt'), 'retained evidence');
      await mkdir(bare, { recursive: true });
      await simpleGit(bare).init(true);
      const manifestPath = join(temporary, 'execution-manifest.json');
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, workItemId, providerBacklogId: '913',
        tracker: { platform: 'github', projectKey: 'doctor-test/api' }, workingBranch: 'afk/913', repositories: [{
          platform: 'github', projectKey: 'doctor-test/api', name: 'api', checkoutPath: 'repositories/api',
          baseBranch: 'main', workingBranch: 'afk/913', primary: true,
        }] }));
      const journals = join(workspaceDataDirectory(workspace), 'executions');
      await mkdir(journals, { recursive: true });
      await writeFile(join(journals, 'attempt.jsonl'), JSON.stringify({ phase: 'merge_ready', at: '2026-11-04T12:00:00Z' }) + '\n');
      const live = await inspectWorkspaceDisk({ manifests: [manifestPath], leases: { active: async () => true } });
      expect(live.repositories.find(entry => entry.path === bare)?.bytes).toBeGreaterThan(0);
      expect(live.workspaces[0]).toMatchObject({ workItemId, active: true, reclaimableBytes: 0 });
      const idle = await inspectWorkspaceDisk({ manifests: [manifestPath], leases: { active: async () => false } });
      expect(idle.workspaces[0].reclaimableBytes).toBe(idle.workspaces[0].bytes);
      expect(idle.totals.reclaimableBytes).toBeGreaterThan(0);
      expect(idle.diagnostics).toEqual([]);
      await writeFile(join(journals, 'attempt.jsonl'), JSON.stringify({ phase: 'blocked', at: '2026-11-04T12:00:00Z' }) + '\n');
      const blocked = await inspectWorkspaceDisk({ manifests: [manifestPath], leases: { active: async () => false } });
      expect(blocked.workspaces[0].reclaimableBytes).toBe(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});
