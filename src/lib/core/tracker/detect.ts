import { simpleGit } from 'simple-git';
import type { Platform } from './types.js';

/**
 * Detect platform from git remote URL
 */
export async function detectPlatform(cwd?: string): Promise<Platform> {
  const remote = await getRemoteUrl(cwd);
  if (!remote) {
    throw new Error('No git remote found. Cannot detect platform.');
  }
  if (remote.includes('github.com')) return 'github';
  return 'gitlab'; // gitlab.com + self-hosted
}

/**
 * Detect GitHub repo from git remote URL
 */
export async function detectGitHubRepo(cwd?: string): Promise<string | null> {
  const remote = await getRemoteUrl(cwd);
  if (!remote) return null;

  // git@github.com:owner/repo.git or https://github.com/owner/repo
  const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

/**
 * Detect GitLab project from git remote URL (existing logic)
 */
export async function detectGitLabProject(cwd?: string): Promise<string | null> {
  const remote = await getRemoteUrl(cwd);
  if (!remote) return null;

  const project = remote
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .trim();

  return project || null;
}

/**
 * Get remote.origin.url from git config
 */
async function getRemoteUrl(cwd?: string): Promise<string | null> {
  try {
    const git = simpleGit(cwd || process.cwd());
    const cfg = await git.getConfig('remote.origin.url');
    return cfg.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect project with platform
 */
export async function detectProject(cwd?: string): Promise<{ platform: Platform; projectId: string }> {
  const platform = await detectPlatform(cwd);

  if (platform === 'github') {
    const projectId = await detectGitHubRepo(cwd);
    if (!projectId) throw new Error('Could not detect GitHub repo from git remote');
    return { platform, projectId };
  } else {
    const projectId = await detectGitLabProject(cwd);
    if (!projectId) throw new Error('Could not detect GitLab project from git remote');
    return { platform, projectId };
  }
}
