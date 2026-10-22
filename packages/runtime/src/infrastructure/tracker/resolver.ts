import { simpleGit } from 'simple-git';
import type { Platform } from '../../domain/tracker/types.js';

/**
 * The provider project a working directory points at.
 *
 * `platform` and `projectId` always describe the same project: the pair is
 * resolved from one `origin` remote and must not be mixed.
 */
export interface RemoteTrackerTarget {
  platform: Platform;
  projectId: string;
  /** Provider instance host the remote points at, for example `gitlab.company.com`. */
  host?: string;
}

export async function resolvePlatform(cwd?: string): Promise<Platform> {
  const remote = await readOriginUrl(cwd);
  if (!remote) throw new Error('No git remote found. Cannot detect platform.');
  return platformFromRemote(remote);
}

export async function resolveGitHubRepository(cwd?: string): Promise<string | null> {
  const remote = await readOriginUrl(cwd);
  if (!remote) return null;
  return parseGitHubRepository(remote);
}

export async function resolveGitLabProject(cwd?: string): Promise<string | null> {
  const remote = await readOriginUrl(cwd);
  if (!remote) return null;
  return parseGitLabProject(remote);
}

export async function resolveTrackerProject(cwd?: string): Promise<{ platform: Platform; projectId: string }> {
  const remote = await readOriginUrl(cwd);
  if (!remote) throw new Error('No git remote found. Cannot detect platform.');
  const platform = platformFromRemote(remote);
  const projectId = platform === 'github' ? parseGitHubRepository(remote) : parseGitLabProject(remote);
  if (!projectId) throw new Error(`Could not detect ${platform} project from git remote`);
  return { platform, projectId };
}

/**
 * Resolve the tracker target from the `origin` remote of a working directory
 * without failing when that directory is not a git repository.
 *
 * Commands that only inspect provider state (for example `afk backlog show`)
 * must work outside a repository, so they need a resolver that reports "no
 * remote" as data instead of throwing. Use `resolveTrackerTarget` to combine
 * this with explicit flags and environment configuration.
 */
export async function resolveRemoteTarget(cwd?: string): Promise<RemoteTrackerTarget | null> {
  const remote = await readOriginUrl(cwd);
  if (!remote) return null;
  const platform = platformFromRemote(remote);
  const projectId = platform === 'github' ? parseGitHubRepository(remote) : parseGitLabProject(remote);
  return projectId ? { platform, projectId, host: parseRemoteHost(remote) } : null;
}

function platformFromRemote(remote: string): Platform {
  return remote.includes('github.com') ? 'github' : 'gitlab';
}

/** The instance host of a remote URL, for both SCP-like and HTTPS remotes. */
function parseRemoteHost(remote: string): string | undefined {
  const scp = remote.match(/^git@([^:]+):/);
  if (scp) return scp[1];
  const url = remote.match(/^https?:\/\/([^/]+)/);
  return url?.[1];
}

function parseGitHubRepository(remote: string): string | null {
  const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function parseGitLabProject(remote: string): string | null {
  const project = remote
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .trim();
  return project || null;
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
