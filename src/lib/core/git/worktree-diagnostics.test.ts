import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { captureWorktreeDiagnostics } from './worktree-diagnostics';

describe('captureWorktreeDiagnostics', () => {
  it('reports tracked settings changes separately from an otherwise clean worktree', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'afk-worktree-diagnostics-'));
    const git = simpleGit(worktree);
    await git.init();
    await git.addConfig('user.name', 'AFK Test');
    await git.addConfig('user.email', 'afk-test@example.test');
    await mkdir(join(worktree, '.claude'));
    await writeFile(join(worktree, '.claude', 'settings.json'), '{"statusLine":"original"}\n');
    await git.add('.');
    await git.commit('initial settings');

    await expect(captureWorktreeDiagnostics(worktree)).resolves.toMatchObject({
      status: [],
      settings: { tracked: true, changed: false },
    });

    await writeFile(join(worktree, '.claude', 'settings.json'), '{"statusLine":"changed"}\n');

    await expect(captureWorktreeDiagnostics(worktree)).resolves.toMatchObject({
      status: [' M .claude/settings.json'],
      settings: { tracked: true, changed: true },
    });
  });
});
