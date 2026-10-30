import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { isAncestorCommit } from './git-ancestry.js';

async function commit(repoRoot: string, file: string, contents: string, message: string): Promise<string> {
  await writeFile(join(repoRoot, file), contents, 'utf8');
  await simpleGit(repoRoot).add('.');
  await simpleGit(repoRoot).commit(message);
  return (await simpleGit(repoRoot).revparse(['HEAD'])).trim();
}

/**
 * One repository with two lines of history: a shared base, then a commit on
 * each of two branches.
 */
async function repositoryWithTwoLines(): Promise<{ root: string; repoRoot: string; base: string; left: string; right: string }> {
  const root = await mkdtemp(join(tmpdir(), 'afk-ancestry-'));
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const git = simpleGit(repoRoot);
  await git.init();
  await git.addConfig('user.name', 'AFK Test');
  await git.addConfig('user.email', 'afk@example.test');
  const base = await commit(repoRoot, 'base.txt', 'base\n', 'base');
  await git.raw(['checkout', '-b', 'left']);
  const left = await commit(repoRoot, 'left.txt', 'left\n', 'left');
  await git.raw(['checkout', 'master']);
  await git.raw(['checkout', '-b', 'right']);
  const right = await commit(repoRoot, 'right.txt', 'right\n', 'right');
  return { root, repoRoot, base, left, right };
}

describe('isAncestorCommit', () => {
  it('reports a commit that the other contains', async () => {
    const { root, repoRoot, base, left } = await repositoryWithTwoLines();
    try {
      const git = simpleGit(repoRoot);
      expect(await isAncestorCommit(git, base, left)).toBe(true);
      expect(await isAncestorCommit(git, base, base)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports two commits on different branches as unrelated', async () => {
    const { root, repoRoot, left, right } = await repositoryWithTwoLines();
    try {
      const git = simpleGit(repoRoot);
      // `git merge-base --is-ancestor` answers this by exiting with a status
      // code and printing nothing, which is how a client that reads error
      // messages ends up believing the answer is yes.
      expect(await isAncestorCommit(git, left, right)).toBe(false);
      expect(await isAncestorCommit(git, right, left)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports commits that share no history as unrelated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-ancestry-'));
    try {
      const repoRoot = join(root, 'repo');
      await mkdir(repoRoot, { recursive: true });
      const git = simpleGit(repoRoot);
      await git.init();
      await git.addConfig('user.name', 'AFK Test');
      await git.addConfig('user.email', 'afk@example.test');
      const first = await commit(repoRoot, 'first.txt', 'first\n', 'first');
      await git.raw(['checkout', '--orphan', 'other']);
      await git.raw(['rm', '-rf', '.']);
      const second = await commit(repoRoot, 'second.txt', 'second\n', 'second');
      expect(await isAncestorCommit(git, first, second)).toBe(false);
      expect(await isAncestorCommit(git, second, first)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
