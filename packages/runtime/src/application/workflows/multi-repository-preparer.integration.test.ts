import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import { MultiRepositoryPreparer } from './multi-repository-preparer.js';
import { resolveWorkflowRunRequest } from './run-request.js';
import { executionWorkspacePath } from '../../infrastructure/workspace.js';
import { isAncestorCommit } from '../../infrastructure/git/git-ancestry.js';

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

async function branchExists(repository: string, branch: string): Promise<boolean> {
  return simpleGit(repository).revparse([`refs/heads/${branch}`]).then(() => true, () => false);
}

describe('multi-repository execution manifest integration', () => {
  it('shares objects across items and preserves unpublished work through retry, publication, and QA borrowing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-store-lifecycle-'));
    try {
      const remote = await createRemote(root, 'shared', 'main');
      const url = 'https://github.com/acme/store-lifecycle.git';
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', `url.${remote.remote}.insteadOf`);
      vi.stubEnv('GIT_CONFIG_VALUE_0', url);
      const firstWorkspace = join(root, 'item-1');
      const secondWorkspace = join(root, 'item-2');
      const firstRoot = join(firstWorkspace, 'repositories', 'api');
      const secondRoot = join(secondWorkspace, 'repositories', 'api');
      const firstRepositories = [{
        platform: 'github' as const, projectKey: 'acme/store-lifecycle', name: 'api', checkoutPath: 'repositories/api',
        repoRoot: firstRoot, baseBranch: 'main', workingBranch: 'afk/store-item-1', primary: true,
      }];
      const secondRepositories = [{ ...firstRepositories[0], repoRoot: secondRoot, workingBranch: 'afk/store-item-2' }];
      const preparer = new MultiRepositoryPreparer();
      const first = await preparer.prepare(firstRepositories, firstWorkspace);
      await expect(preparer.prepare(secondRepositories, secondWorkspace)).rejects.toThrow('leased');
      const git = simpleGit(firstRoot);
      const firstCommon = (await git.raw(['rev-parse', '--git-common-dir'])).trim();
      await git.addConfig('user.name', 'AFK Integration');
      await git.addConfig('user.email', 'afk-integration@example.test');
      await writeFile(join(firstRoot, 'implementation.txt'), 'unpublished work\n');
      await git.add('.');
      await git.commit('implementation');
      const implementation = (await git.revparse(['HEAD'])).trim();
      const conflictingRoot = join(root, 'item-3', 'repositories', 'api');
      await expect(preparer.prepare([{ ...firstRepositories[0], repoRoot: conflictingRoot }], join(root, 'item-3'))).rejects.toThrow();
      expect((await git.revparse(['HEAD'])).trim()).toBe(implementation);
      await expect(lstat(conflictingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(join(firstRoot, 'pending.txt'), 'uncommitted work\n');
      await writeFile(join(firstRoot, 'package.json'), '{"private":true}');
      await writeFile(join(firstRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(join(firstRoot, '.gitignore'), 'node_modules/\n');
      await mkdir(join(firstRoot, 'node_modules/lib'), { recursive: true });
      await writeFile(join(firstRoot, 'node_modules/lib/index.js'), 'retained dependency');
      await first.finish({ status: 'failed' });
      await expect(lstat(join(firstRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
      const recovered = await preparer.prepare(firstRepositories, firstWorkspace);
      expect(await readFile(join(firstRoot, 'pending.txt'), 'utf8')).toBe('uncommitted work\n');
      expect(await readFile(join(firstRoot, 'node_modules/lib/index.js'), 'utf8')).toBe('retained dependency');
      expect((await git.raw(['stash', 'list'])).trim()).toContain('afk-recovery-');
      await git.add('.');
      await git.commit('preserved pending work');
      await recovered.finish({ status: 'failed' });
      const published = (await git.revparse(['HEAD'])).trim();
      const retry = await preparer.prepare(firstRepositories, firstWorkspace);
      expect((await git.revparse(['HEAD'])).trim()).toBe(published);
      await retry.finish({ status: 'success' });
      await expect(lstat(firstRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await simpleGit(remote.remote).revparse(['refs/heads/afk/store-item-1'])).trim()).toBe(published);
      expect(await isAncestorCommit(simpleGit(remote.remote), implementation, published)).toBe(true);
      const second = await preparer.prepare(secondRepositories, secondWorkspace);
      const secondCommon = (await simpleGit(secondRoot).raw(['rev-parse', '--git-common-dir'])).trim();
      expect(await realpath(firstCommon)).toBe(await realpath(secondCommon));
      expect(await readFile(join(secondRoot, 'shared.txt'), 'utf8')).toBe('main\n');
      await second.release();
      await expect(lstat(secondRoot)).rejects.toMatchObject({ code: 'ENOENT' });

      const borrowed = await preparer.prepare(firstRepositories, firstWorkspace);
      expect((await simpleGit(firstRoot).revparse(['HEAD'])).trim()).toBe(published);
      await borrowed.release();
      await expect(lstat(firstRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await simpleGit(firstCommon).raw(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves unpublished commits on existing and newly created working branches across failed retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-multi-repository-retry-'));
    try {
      const workspaceRoot = join(root, 'workspace');
      const apiRoot = join(workspaceRoot, 'repositories', 'api');
      const webRoot = join(workspaceRoot, 'repositories', 'web');
      const workingBranch = 'afk/work-item-retry';
      const api = await createRemote(root, 'api', 'main');
      const web = await createRemote(root, 'web', 'develop');
      await cloneRemote(api.remote, apiRoot, 'main', 'https://github.com/acme/api.git');
      await cloneRemote(web.remote, webRoot, 'develop', 'https://gitlab.com/acme/web.git');

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
      // The work the first attempt did sits on top of the work that was
      // already there, so nothing was lost when the branch was prepared again.
      expect(await isAncestorCommit(apiGit, existingHead, firstApiHead)).toBe(true);
      expect(await readFile(join(apiRoot, 'first-api.txt'), 'utf8')).toBe('first attempt\n');
      expect(await readFile(join(webRoot, 'first-web.txt'), 'utf8')).toBe('first attempt\n');
      expect(await branchExists(api.remote, workingBranch)).toBe(false);
      expect(await branchExists(web.remote, workingBranch)).toBe(false);
    } finally {
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

  it('prepares both repositories from their own bases, cleans success and preserves failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-multi-repository-integration-'));
    try {
      const workspaceRoot = executionWorkspacePath('WI-2026-018');
      const apiRoot = join(workspaceRoot, 'repositories', 'api');
      const webRoot = join(workspaceRoot, 'repositories', 'web');
      const manifestPath = join(workspaceRoot, '.afk', 'execution-manifest.json');
      const workingBranch = 'afk/work-item-18';
      const api = await createRemote(root, 'api', 'main');
      const web = await createRemote(root, 'web', 'develop');
      await cloneRemote(api.remote, apiRoot, 'main', 'https://github.com/acme/api.git');
      await cloneRemote(web.remote, webRoot, 'develop', 'https://gitlab.com/acme/web.git');
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
      await rm(root, { recursive: true, force: true });
    }
  });
});
