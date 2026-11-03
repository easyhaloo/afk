import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { defaultDependencies } from './multi-repository-preparer.js';
import { isAncestorCommit } from '../../infrastructure/git/git-ancestry.js';

async function identify(repoRoot: string): Promise<void> {
  const git = simpleGit(repoRoot);
  await git.addConfig('user.name', 'AFK Test');
  await git.addConfig('user.email', 'afk@example.test');
}

/**
 * A remote with a published branch, a clone of it, and the local branch
 * carrying work that was never published.
 */
async function repositoryWithLocalWork(): Promise<{
  repoRoot: string;
  remoteRoot: string;
  localCommit: string;
  remoteCommit: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'afk-branch-'));
  const remoteRoot = join(root, 'remote.git');
  const repoRoot = join(root, 'clone');
  const seed = join(root, 'seed');

  await mkdir(remoteRoot, { recursive: true });
  await simpleGit(remoteRoot).init(true);
  await simpleGit(remoteRoot).raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

  await mkdir(seed, { recursive: true });
  await simpleGit().clone(remoteRoot, seed);
  await identify(seed);
  await writeFile(join(seed, 'base.txt'), 'base\n');
  await simpleGit(seed).add('.');
  await simpleGit(seed).commit('base');
  await simpleGit(seed).push('origin', 'HEAD:main');
  await simpleGit(seed).push('origin', 'HEAD:afk/backlog-2');
  const remoteCommit = (await simpleGit(seed).revparse(['HEAD'])).trim();

  await mkdir(repoRoot, { recursive: true });
  await simpleGit().clone(remoteRoot, repoRoot);
  await identify(repoRoot);
  await simpleGit(repoRoot).raw(['checkout', '-B', 'afk/backlog-2', 'origin/afk/backlog-2']);
  await writeFile(join(repoRoot, 'work.txt'), 'the implementation\n');
  await simpleGit(repoRoot).add('.');
  await simpleGit(repoRoot).commit('the implementation');
  const localCommit = (await simpleGit(repoRoot).revparse(['HEAD'])).trim();

  return { repoRoot, remoteRoot, localCommit, remoteCommit, root };
}

describe('working branch preparation', () => {
  it('keeps work that was made but never published', async () => {
    const { repoRoot, localCommit, root } = await repositoryWithLocalWork();
    try {
      await defaultDependencies().git.prepareWorkingBranch(repoRoot, 'main', 'afk/backlog-2');

      const head = (await simpleGit(repoRoot).revparse(['HEAD'])).trim();
      expect(head).toBe(localCommit);
      expect(await simpleGit(repoRoot).raw(['status', '--porcelain=v1'])).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('takes the published branch when it has moved on', async () => {
    const { repoRoot, remoteRoot, root } = await repositoryWithLocalWork();
    try {
      // The previous attempt published its work, and the published branch has
      // moved on since.
      const other = join(root, 'other');
      await mkdir(other, { recursive: true });
      await simpleGit().clone(remoteRoot, other);
      await identify(other);
      await simpleGit(other).raw(['checkout', '-B', 'afk/backlog-2', 'origin/afk/backlog-2']);
      await writeFile(join(other, 'published.txt'), 'published\n');
      await simpleGit(other).add('.');
      await simpleGit(other).commit('published');
      await simpleGit(other).push('origin', 'afk/backlog-2');
      const publishedCommit = (await simpleGit(other).revparse(['HEAD'])).trim();
      // The local branch is at the published commit: the work is on the
      // remote already.
      await simpleGit(repoRoot).raw(['fetch', 'origin']);
      await simpleGit(repoRoot).raw(['reset', '--hard', 'origin/afk/backlog-2']);

      // Someone publishes one more commit on the branch.
      await writeFile(join(other, 'newer.txt'), 'newer\n');
      await simpleGit(other).add('.');
      await simpleGit(other).commit('newer');
      const newerCommit = (await simpleGit(other).revparse(['HEAD'])).trim();
      await simpleGit(other).push('origin', 'afk/backlog-2');
      // The published commit has to be on the remote for this to mean
      // anything; without the check a broken push would look like a branch
      // preparation problem.
      const remoteRefs = await simpleGit().raw(['ls-remote', remoteRoot]);
      expect(remoteRefs).toContain(newerCommit);

      await defaultDependencies().git.prepareWorkingBranch(repoRoot, 'main', 'afk/backlog-2');

      const head = (await simpleGit(repoRoot).revparse(['HEAD'])).trim();
      expect(head).toBe(newerCommit);
      expect(head).not.toBe(publishedCommit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps local work when the published branch moved on in another direction', async () => {
    const { repoRoot, remoteRoot, localCommit, root } = await repositoryWithLocalWork();
    try {
      // Someone publishes a commit that is not on top of the local work: the
      // two branches have diverged.
      const other = join(root, 'other');
      await mkdir(other, { recursive: true });
      await simpleGit().clone(remoteRoot, other);
      await identify(other);
      await simpleGit(other).raw(['checkout', '-B', 'afk/backlog-2', 'origin/afk/backlog-2']);
      await writeFile(join(other, 'published.txt'), 'published\n');
      await simpleGit(other).add('.');
      await simpleGit(other).commit('published');
      const publishedCommit = (await simpleGit(other).revparse(['HEAD'])).trim();
      await simpleGit(other).push('origin', 'afk/backlog-2');

      await defaultDependencies().git.prepareWorkingBranch(repoRoot, 'main', 'afk/backlog-2');

      const head = (await simpleGit(repoRoot).revparse(['HEAD'])).trim();
      expect(head).toBe(localCommit);

      // Publishing brings the published work back in, so the push is not
      // rejected and neither side of the divergence is lost.
      await defaultDependencies().git.finalize(repoRoot, 'afk/backlog-2');

      const publishedHead = (await simpleGit(repoRoot).revparse(['refs/remotes/origin/afk/backlog-2'])).trim();
      const git = simpleGit(repoRoot);
      expect(await isAncestorCommit(git, localCommit, publishedHead)).toBe(true);
      expect(await isAncestorCommit(git, publishedCommit, publishedHead)).toBe(true);
      expect(await readFile(join(repoRoot, 'work.txt'), 'utf8')).toBe('the implementation\n');
      expect(await readFile(join(repoRoot, 'published.txt'), 'utf8')).toBe('published\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('takes the published branch when the local one has nothing of its own', async () => {
    const { repoRoot, remoteRoot, root } = await repositoryWithLocalWork();
    try {
      // The local work is given up: the local branch is back at the published
      // commit, so there is nothing to keep.
      await simpleGit(repoRoot).raw(['reset', '--hard', 'origin/afk/backlog-2']);

      const other = join(root, 'other');
      await mkdir(other, { recursive: true });
      await simpleGit().clone(remoteRoot, other);
      await identify(other);
      await simpleGit(other).raw(['checkout', '-B', 'afk/backlog-2', 'origin/afk/backlog-2']);
      await writeFile(join(other, 'published.txt'), 'published\n');
      await simpleGit(other).add('.');
      await simpleGit(other).commit('published');
      const publishedCommit = (await simpleGit(other).revparse(['HEAD'])).trim();
      await simpleGit(other).push('origin', 'afk/backlog-2');

      await defaultDependencies().git.prepareWorkingBranch(repoRoot, 'main', 'afk/backlog-2');

      const head = (await simpleGit(repoRoot).revparse(['HEAD'])).trim();
      expect(head).toBe(publishedCommit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
