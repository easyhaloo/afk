import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitLabClient } from './index.js';

function worktreeWithArtifact(relativePath: string): { worktree: string; artifact: string } {
  const worktree = mkdtempSync(join(tmpdir(), 'afk-artifacts-'));
  mkdirSync(join(worktree, '.afk'));
  const artifact = join(worktree, relativePath);
  writeFileSync(artifact, '路由映射就绪\n');
  writeFileSync(join(worktree, '.afk', 'artifacts.txt'), `${artifact}\n`);
  return { worktree, artifact };
}

describe('GitLabClient uploadArtifacts', () => {
  it('publishes an absolute attachment URL so the link is not rewritten into a repository path', async () => {
    const { worktree } = worktreeWithArtifact('evidence.log');
    const client = new GitLabClient({
      url: 'https://gitlab.example.test',
      token: 'token',
      projectId: 'team/project',
    });
    const upload = vi.fn().mockResolvedValue({
      full_path: '/team/project/uploads/abc123/evidence.log',
      url: '/uploads/abc123/evidence.log',
    });
    (client as unknown as { client: { Projects: { upload: typeof upload } } }).client = {
      Projects: { upload },
    };

    await expect(client.uploadArtifacts(worktree)).resolves.toEqual([
      { name: 'evidence.log', url: 'https://gitlab.example.test/team/project/uploads/abc123/evidence.log' },
    ]);
    expect(upload).toHaveBeenCalledWith(
      'team/project',
      expect.any(Buffer),
      expect.objectContaining({ metadata: { filename: 'evidence.log' } }),
    );
  });

  it('returns no artifacts when the run registered none', async () => {
    const client = new GitLabClient({
      url: 'https://gitlab.example.test',
      token: 'token',
      projectId: 'team/project',
    });
    const upload = vi.fn();
    (client as unknown as { client: { Projects: { upload: typeof upload } } }).client = {
      Projects: { upload },
    };
    const worktree = mkdtempSync(join(tmpdir(), 'afk-artifacts-empty-'));

    await expect(client.uploadArtifacts(worktree)).resolves.toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });
});
