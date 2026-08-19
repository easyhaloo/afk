import { simpleGit } from 'simple-git';
import type { Platform } from '../../domain/tracker/types';

export async function resolvePlatform(cwd?: string): Promise<Platform> {
  const remote = await readOriginUrl(cwd);
  if (!remote) throw new Error('No git remote found. Cannot detect platform.');
  return remote.includes('github.com') ? 'github' : 'gitlab';
}

export async function resolveGitHubRepository(cwd?: string): Promise<string | null> {
  const remote = await readOriginUrl(cwd);
  if (!remote) return null;
  const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

export async function resolveGitLabProject(cwd?: string): Promise<string | null> {
  const remote = await readOriginUrl(cwd);
  if (!remote) return null;
  const project = remote
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .trim();
  return project || null;
}

export async function resolveTrackerProject(cwd?: string): Promise<{ platform: Platform; projectId: string }> {
  const platform = await resolvePlatform(cwd);
  const projectId = platform === 'github'
    ? await resolveGitHubRepository(cwd)
    : await resolveGitLabProject(cwd);
  if (!projectId) throw new Error(`Could not detect ${platform} project from git remote`);
  return { platform, projectId };
}

async function readOriginUrl(cwd?: string): Promise<string | null> {
  try {
    const git = simpleGit(cwd ?? process.cwd());
    const config = await git.getConfig('remote.origin.url');
    return config.value ?? null;
  } catch {
    return null;
  }
}
