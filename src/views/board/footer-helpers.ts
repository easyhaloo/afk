/**
 * Footer helpers — extracted from Footer.tsx for testability.
 *
 * Both functions are pure(ish) and side-effect free aside from reading
 * process.cwd() / process.env (getShortPath) and shelling out to git
 * (getGitBranch). They are called once on Footer mount.
 */
import simpleGit from 'simple-git';

/** Returns cwd with $HOME prefix replaced by `~`. Falls back to cwd. */
export function getShortPath(): string {
  const cwd = process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

/** Returns the current git branch, or null if not in a git repository. */
export async function getGitBranch(): Promise<string | null> {
  try {
    const git = simpleGit();
    const result = await git.branchLocal();
    return result.current || null;
  } catch {
    return null;
  }
}

/** Compose the Footer path label: `~/path (branch)` or `~/path` when no branch. */
export function formatPathLabel(path: string, branch: string | null): string {
  return branch ? `${path} (${branch})` : path;
}
