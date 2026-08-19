import { simpleGit } from 'simple-git';

/**
 * Detect GitLab project path from the 'origin' remote URL.
 * Uses simple-git SDK (reads .git/config internally, no subprocess).
 */
export async function detectGitLabProject(cwd?: string): Promise<string | null> {
  try {
    const git = simpleGit(cwd || process.cwd());
    const cfg = await git.getConfig('remote.origin.url');
    const url = cfg.value;
    if (!url) return null;

    const project = url
      .replace(/^git@[^:]+:/, '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/\.git$/, '')
      .trim();

    return project || null;
  } catch {
    return null;
  }
}
