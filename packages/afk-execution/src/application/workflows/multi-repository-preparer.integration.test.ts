import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { MultiRepositoryPreparer } from './multi-repository-preparer.js';
import { resolveWorkflowRunRequest } from './run-request.js';

async function createRemote(
  root: string,
  name: string,
  baseBranch: string,
): Promise<{ remote: string; head: string }> {
  const seed = join(root, `${name}-seed`);
  const remote = join(root, `${name}.git`);
  await mkdir(seed, { recursive: true });
  const git = simpleGit(seed);
  await git.init([`--initial-branch=${baseBranch}`]);
  await git.addConfig('user.name', 'AFK Integration');
  await git.addConfig('user.email', 'afk-integration@example.test');
  await writeFile(join(seed, `${name}.txt`), `${baseBranch}\n`, 'utf8');
  await git.add('.');
  await git.commit(`${name} baseline`);
  const head = (await git.revparse(['HEAD'])).trim();
  await simpleGit().clone(seed, remote, ['--bare']);
  return { remote, head };
}

async function cloneRemote(remote: string, target: string, branch: string, url: string): Promise<void> {
  await simpleGit().clone(remote, target, ['--branch', branch]);
  const git = simpleGit(target);
  await git.addConfig('user.name', 'AFK Integration');
  await git.addConfig('user.email', 'afk-integration@example.test');
  await git.raw(['config', '--local', `url.${remote}.insteadOf`, url]);
  await git.raw(['remote', 'set-url', 'origin', url]);
}

/**
 * Redirect the canonical clone URLs to this test's own bare remotes.
 *
 * The redirect has to be global. A local redirect lives in the configuration
 * of one clone, and the code under test may clone a repository that does not
 * exist yet — a fresh clone carries no configuration of its own, so that
 * path would reach for the real github.com and fail for reasons that have
 * nothing to do with what is being tested. An integration test must not
 * depend on the machine's network.
 *
 * Returns the undo, so the caller can restore the environment.
 */
function installGitUrlRedirects(entries: { remote: string; url: string }[]): () => void {
  process.env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach((entry, index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = `url.${entry.remote}.insteadOf`;
    process.env[`GIT_CONFIG_VALUE_${index}`] = entry.url;
  });
  return () => {
    delete process.env.GIT_CONFIG_COUNT;
    for (let index = 0; index < entries.length; index += 1) {
      delete process.env[`GIT_CONFIG_KEY_${index}`];
      delete process.env[`GIT_CONFIG_VALUE_${index}`];
    }
  };
}

async function branchExists(repository: string, branch: string): Promise<boolean> {
  return simpleGit(repository).revparse([`refs/heads/${branch}`]).then(() => true, () => false);
}

describe('multi-repository execution manifest integration', () => {
  it('preserves unpublished commits on existing and newly created working branches across failed retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-multi-repository-retry-'));
    let restoreGitRedirects = () => {};
    try {
      const workspaceRoot = join(root, 'workspace');
      const apiRoot = join(workspaceRoot, 'repositories', 'api');
      const webRoot = join(workspaceRoot, 'repositories', 'web');
      const workingBranch = 'afk/work-item-retry';
      const api = await createRemote(root, 'api', 'main');
      const web = await createRemote(root, 'web', 'develop');
      await cloneRemote(api.remote, apiRoot, 'main', 'https://github.com/acme/api.git');
      await cloneRemote(web.remote, webRoot, 'develop', 'https://gitlab.com/acme/web.git');
      restoreGitRedirects = installGitUrlRedirects([
        { remote: api.remote, url: 'https://github.com/acme/api.git' },
        { remote: web.remote, url: 'https://gitlab.com/acme/web.git' },
      ]);

      const apiGit = simpleGit(apiRoot);
      const webGit = simpleGit(webRoot);
      await apiGit.raw(['checkout', '-b', workingBranch]);
      await writeFile(join(apiRoot, 'existing.txt'), 'existing unpublished commit\n', 'utf8');
      await apiGit.add('existing.txt');
      await apiGit.commit('existing unpublished change');
      const existingHead = (await apiGit.revparse(['HEAD'])).trim();
      await apiGit.raw(['checkout', 'main']);
      expect(await branchExists(webRoot, workingBranch)).toBe(false);

      const repositories = [
        {
          platform: 'github' as const, projectKey: 'acme/api', name: 'api', checkoutPath: 'repositories/api',
          repoRoot: apiRoot, baseBranch: 'main', workingBranch, primary: true,
        },
        {
          platform: 'gitlab' as const, projectKey: 'acme/web', name: 'web', checkoutPath: 'repositories/web',
          repoRoot: webRoot, baseBranch: 'develop', workingBranch, primary: false,
        },
      ];
      const preparer = new MultiRepositoryPreparer();
      const first = await preparer.prepare(repositories, workspaceRoot);
      await writeFile(join(apiRoot, 'first-api.txt'), 'first attempt\n', 'utf8');
      await apiGit.add('first-api.txt');
      await apiGit.commit('first api attempt');
      await writeFile(join(webRoot, 'first-web.txt'), 'first attempt\n', 'utf8');
      await webGit.add('first-web.txt');
      await webGit.commit('first web attempt');
      const firstApiHead = (await apiGit.revparse(['HEAD'])).trim();
      const firstWebHead = (await webGit.revparse(['HEAD'])).trim();
      await first.finish({ status: 'failed' });

      const retry = await preparer.prepare(repositories, workspaceRoot);
      await retry.finish({ status: 'failed' });

      expect((await apiGit.revparse(['HEAD'])).trim()).toBe(firstApiHead);
      expect((await webGit.revparse(['HEAD'])).trim()).toBe(firstWebHead);
      expect((await apiGit.revparse([`refs/heads/${workingBranch}`])).trim()).toBe(firstApiHead);
      expect((await webGit.revparse([`refs/heads/${workingBranch}`])).trim()).toBe(firstWebHead);
      expect(await apiGit.raw(['merge-base', '--is-ancestor', existingHead, firstApiHead])).toBe('');
      expect(await readFile(join(apiRoot, 'first-api.txt'), 'utf8')).toBe('first attempt\n');
      expect(await readFile(join(webRoot, 'first-web.txt'), 'utf8')).toBe('first attempt\n');
      expect(await branchExists(api.remote, workingBranch)).toBe(false);
      expect(await branchExists(web.remote, workingBranch)).toBe(false);
    } finally {
      restoreGitRedirects();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuilds a released checkout for a borrowing phase and releases it without pushing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-qa-workspace-'));
    try {
      const workspaceRoot = join(root, 'workspace');
      const repoRoot = join(workspaceRoot, 'repositories', 'api');
      const workingBranch = 'afk/backlog-60';
      const api = await createRemote(root, 'api', 'main');
      // implementation pushed its branch, then released the checkout.
      await simpleGit(api.remote).raw(['branch', workingBranch, 'main']);
      // the clone URL is derived from the tracker identity, so redirect it
      // per-invocation instead of rewriting the machine's git config.
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = `url.${api.remote}.insteadOf`;
      process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/api.git';

      const repositories = [{
        platform: 'github' as const, projectKey: 'acme/api', name: 'api', checkoutPath: 'repositories/api',
        repoRoot, baseBranch: 'main', workingBranch, primary: true,
      }];
      const preparer = new MultiRepositoryPreparer();

      // QA has no checkout to borrow: it rebuilds one, and that rebuilt
      // checkout must be usable as a worktree source.
      const borrowed = await preparer.prepare(repositories, workspaceRoot);
      expect(borrowed.primary.handle.path).toBe(repoRoot);
      const rebuilt = simpleGit(repoRoot);
      expect((await rebuilt.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(workingBranch);
      const qaWorktree = join(repoRoot, '.worktrees', 'afk-backlog-60-qa');
      await rebuilt.raw(['worktree', 'add', '-b', 'afk/backlog-60-qa', qaWorktree, 'main']);

      await borrowed.release();

      await expect(readFile(qaWorktree, 'utf8').catch(() => Promise.reject(new Error('released')))).rejects.toThrow();
      expect(await branchExists(api.remote, workingBranch)).toBe(true);
      expect(await branchExists(api.remote, 'afk/backlog-60-qa')).toBe(false);
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the canonical clone URL to the test\'s own remote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-multi-repository-hermetic-'));
    try {
      const api = await createRemote(root, 'api', 'main');
      const restoreGitRedirects = installGitUrlRedirects([
        { remote: api.remote, url: 'https://github.com/acme/api.git' },
      ]);
      // A clone made while the code under test runs carries no configuration of
      // its own. If the redirect were only local, this would reach for the real
      // github.com — and the test would depend on the machine's network.
      const fresh = join(root, 'fresh');
      await simpleGit().clone('https://github.com/acme/api.git', fresh, ['--branch', 'main']);
      expect((await simpleGit(fresh).revparse(['HEAD'])).trim()).toBe(api.head);
      restoreGitRedirects();
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prepares both repositories from their own bases, cleans success and preserves failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-multi-repository-integration-'));
    let restoreGitRedirects = () => {};
    try {
      const workspaceRoot = join(root, 'workspace');
      const apiRoot = join(workspaceRoot, 'repositories', 'api');
      const webRoot = join(workspaceRoot, 'repositories', 'web');
      const manifestPath = join(workspaceRoot, '.afk', 'execution-manifest.json');
      const workingBranch = 'afk/work-item-18';
      const api = await createRemote(root, 'api', 'main');
      const web = await createRemote(root, 'web', 'develop');
      await cloneRemote(api.remote, apiRoot, 'main', 'https://github.com/acme/api.git');
      await cloneRemote(web.remote, webRoot, 'develop', 'https://gitlab.com/acme/web.git');
      restoreGitRedirects = installGitUrlRedirects([
        { remote: api.remote, url: 'https://github.com/acme/api.git' },
        { remote: web.remote, url: 'https://gitlab.com/acme/web.git' },
      ]);
      await mkdir(join(workspaceRoot, '.afk'), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        workItemId: 'WI-2026-018',
        providerBacklogId: '42',
        tracker: { platform: 'github', projectKey: 'acme/api' },
        workingBranch,
        repositories: [
          {
            platform: 'github', projectKey: 'acme/api', name: 'api', checkoutPath: 'repositories/api',
            baseBranch: 'main', workingBranch, primary: true,
          },
          {
            platform: 'gitlab', projectKey: 'acme/web', name: 'web', checkoutPath: 'repositories/web',
            baseBranch: 'develop', workingBranch, primary: false,
          },
        ],
      }, null, 2)}\n`, 'utf8');

      const request = await resolveWorkflowRunRequest({
        backlogId: 'WI-2026-018',
        executionManifestPath: manifestPath,
      }, {}, { cwd: workspaceRoot });

      expect(request).toMatchObject({
        backlogId: '42',
        repoRoot: apiRoot,
        workspaceRoot,
        baseBranch: 'main',
        targetBranch: workingBranch,
      });
      expect(request.repositories).toEqual([
        expect.objectContaining({ repoRoot: apiRoot, baseBranch: 'main', primary: true }),
        expect.objectContaining({ repoRoot: webRoot, baseBranch: 'develop', primary: false }),
      ]);

      const preparer = new MultiRepositoryPreparer();
      const prepared = await preparer.prepare(request.repositories!, request.workspaceRoot);
      expect(prepared.primary.repoRoot).toBe(apiRoot);
      expect(prepared.repositories.map(repository => repository.repoRoot)).toEqual([apiRoot, webRoot]);
      expect((await simpleGit(apiRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(workingBranch);
      expect((await simpleGit(webRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(workingBranch);
      expect((await simpleGit(apiRoot).revparse(['HEAD'])).trim()).toBe(api.head);
      expect((await simpleGit(webRoot).revparse(['HEAD'])).trim()).toBe(web.head);

      await writeFile(join(apiRoot, 'api-change.txt'), 'api change\n', 'utf8');
      await simpleGit(apiRoot).add('.');
      await simpleGit(apiRoot).commit('api change');
      await writeFile(join(webRoot, 'web-change.txt'), 'web change\n', 'utf8');
      await simpleGit(webRoot).add('.');
      await simpleGit(webRoot).commit('web change');
      const apiWorkingHead = (await simpleGit(apiRoot).revparse(['HEAD'])).trim();
      const webWorkingHead = (await simpleGit(webRoot).revparse(['HEAD'])).trim();

      await prepared.finish({ status: 'success' });

      expect((await simpleGit(api.remote).revparse([`refs/heads/${workingBranch}`])).trim()).toBe(apiWorkingHead);
      expect((await simpleGit(web.remote).revparse([`refs/heads/${workingBranch}`])).trim()).toBe(webWorkingHead);
      expect((await simpleGit(apiRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');
      expect((await simpleGit(webRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('develop');
      expect(await branchExists(apiRoot, workingBranch)).toBe(false);
      expect(await branchExists(webRoot, workingBranch)).toBe(false);
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({ workItemId: 'WI-2026-018' });

      const remoteHeadsBeforeFailure = [
        (await simpleGit(api.remote).revparse([`refs/heads/${workingBranch}`])).trim(),
        (await simpleGit(web.remote).revparse([`refs/heads/${workingBranch}`])).trim(),
      ];
      const failed = await preparer.prepare(request.repositories!, request.workspaceRoot);
      await writeFile(join(apiRoot, 'unpublished.txt'), 'do not publish\n', 'utf8');
      await simpleGit(apiRoot).add('.');
      await simpleGit(apiRoot).commit('unpublished api change');
      const unpublishedHead = (await simpleGit(apiRoot).revparse(['HEAD'])).trim();
      await writeFile(join(apiRoot, 'untracked.txt'), 'keep untracked\n', 'utf8');
      await writeFile(join(webRoot, 'web.txt'), 'keep tracked\n', 'utf8');
      await writeFile(join(webRoot, 'staged.txt'), 'keep staged\n', 'utf8');
      await simpleGit(webRoot).add('staged.txt');
      await failed.finish({ status: 'failed' });

      expect((await simpleGit(api.remote).revparse([`refs/heads/${workingBranch}`])).trim()).toBe(remoteHeadsBeforeFailure[0]);
      expect((await simpleGit(web.remote).revparse([`refs/heads/${workingBranch}`])).trim()).toBe(remoteHeadsBeforeFailure[1]);
      expect((await simpleGit(apiRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(workingBranch);
      expect((await simpleGit(webRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(workingBranch);
      expect((await simpleGit(apiRoot).revparse(['HEAD'])).trim()).toBe(unpublishedHead);
      expect(await branchExists(apiRoot, workingBranch)).toBe(true);
      expect(await branchExists(webRoot, workingBranch)).toBe(true);
      expect(await readFile(join(apiRoot, 'untracked.txt'), 'utf8')).toBe('keep untracked\n');
      expect(await readFile(join(webRoot, 'web.txt'), 'utf8')).toBe('keep tracked\n');
      expect(await readFile(join(webRoot, 'staged.txt'), 'utf8')).toBe('keep staged\n');
      expect((await simpleGit(webRoot).raw(['status', '--porcelain=v1']))).toContain(' M web.txt');
      expect((await simpleGit(webRoot).raw(['status', '--porcelain=v1']))).toContain('A  staged.txt');
      expect(await readFile(manifestPath, 'utf8')).toContain('"primary": true');
    } finally {
      restoreGitRedirects();
      await rm(root, { recursive: true, force: true });
    }
  });
});
