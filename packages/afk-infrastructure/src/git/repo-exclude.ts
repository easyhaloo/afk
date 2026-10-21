import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * The files AFK leaves inside a repository it works in.
 *
 * They are AFK's own working files, not the user's work: the worktrees it
 * creates, the execution journal, the handoff documents, the completion
 * signal the agent writes. `git add -A` picks them up - and AFK runs
 * `git add -A` itself when it commits the agent's work - so they end up
 * in the user's branch, in the change request, and in the history of a
 * repository somebody else will clone.
 *
 * The list is here so there is one answer to "what does AFK leave
 * behind". The patterns are relative to the top of a checkout, which is
 * what git's exclude file expects: one pattern covers the main checkout
 * and every worktree of the same repository.
 */
export const AFK_REPO_ARTEFACTS: readonly string[] = [
  '/.worktrees/',
  '/.afk/',
  '/.afk-signal.json*',
  '/.claude/settings.local.json',
];

/**
 * Keep AFK's artefacts out of a repository's commits.
 *
 * The exclusion goes into the repository's own exclude file. That file is
 * local to the repository and is never committed, so the user's history
 * stays clean without touching a file they track - and because git reads
 * it for every checkout of the repository, one write covers the main
 * checkout and the worktrees alike.
 *
 * A directory that is not a git repository has no commits to keep clean,
 * and is left alone.
 */
export async function excludeAfkArtefacts(repoPath: string): Promise<void> {
  const excludePath = await resolveExcludePath(repoPath);
  if (!excludePath) return;

  const existing = await readFile(excludePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const present = new Set(existing.split(/\r?\n/).map(line => line.trim()));
  const missing = AFK_REPO_ARTEFACTS.filter(pattern => !present.has(pattern));
  if (missing.length === 0) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await appendFile(excludePath, `${separator}${missing.join('\n')}\n`);
}

/** Where the repository keeps its exclude file, when it is a repository at all. */
async function resolveExcludePath(repoPath: string): Promise<string | undefined> {
  try {
    const gitPath = (await simpleGit(repoPath).raw(['rev-parse', '--git-path', 'info/exclude'])).trim();
    if (!gitPath) return undefined;
    return resolve(repoPath, gitPath);
  } catch {
    return undefined;
  }
}
