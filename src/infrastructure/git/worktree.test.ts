import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorktreeManager, WorktreeManager } from './index';

describe('WorktreeManager', () => {
  it('loads state from the requested repository and preserves worktree metadata', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'afk-worktree-state-'));
    try {
      await mkdir(join(repoPath, '.afk'));
      await writeFile(join(repoPath, '.afk', 'worktrees.json'), JSON.stringify({
        worktrees: { 42: {
          iid: 42,
          path: join(repoPath, 'issue-42'),
          branch: 'afk-issue-42',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'active',
          markerStatus: 'success',
        } },
      }));

      const manager = createWorktreeManager(repoPath);
      expect(manager).toBeInstanceOf(WorktreeManager);
      await expect(manager.get(42)).resolves.toMatchObject({
        iid: 42,
        markerStatus: 'success',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      await expect(manager.get(43)).resolves.toBeNull();
      expect(await readFile(join(repoPath, '.afk', 'worktrees.json'), 'utf8')).toContain('afk-issue-42');
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
