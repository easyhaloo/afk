import { describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import { resolveGitHubRepository, resolveGitLabProject, resolvePlatform, resolveTrackerProject } from './resolver';

vi.mock('simple-git', () => ({ simpleGit: vi.fn() }));

describe('tracker remote resolver', () => {
  it('detects GitHub repositories from origin', async () => {
    vi.mocked(simpleGit).mockReturnValue({ getConfig: vi.fn().mockResolvedValue({ value: 'git@github.com:team/repo.git' }) } as never);
    await expect(resolveTrackerProject('/repo')).resolves.toEqual({ platform: 'github', projectId: 'team/repo' });
    await expect(resolveGitHubRepository('/repo')).resolves.toBe('team/repo');
  });

  it('detects self-hosted GitLab projects from origin', async () => {
    vi.mocked(simpleGit).mockReturnValue({ getConfig: vi.fn().mockResolvedValue({ value: 'https://git.example/team/repo.git' }) } as never);
    await expect(resolveTrackerProject('/repo')).resolves.toEqual({ platform: 'gitlab', projectId: 'team/repo' });
    await expect(resolveGitLabProject('/repo')).resolves.toBe('team/repo');
  });

  it('rejects platform detection without a remote', async () => {
    vi.mocked(simpleGit).mockReturnValue({ getConfig: vi.fn().mockResolvedValue({ value: null }) } as never);
    await expect(resolvePlatform('/repo')).rejects.toThrow('No git remote found. Cannot detect platform.');
  });
});
