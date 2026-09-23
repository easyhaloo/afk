import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import {
  acquireWorkspaceLock,
  assertRepositoryOrigin,
  cloneUrl,
  MultiRepositoryPreparer,
  type MultiRepositoryPreparerDependencies,
  type RepositoryGitSnapshot,
  type WorkspaceLockDependencies,
} from './multi-repository-preparer';
import type { WorkflowRunRepository } from './run-request';

function repository(overrides: Partial<WorkflowRunRepository> = {}): WorkflowRunRepository {
  return {
    platform: 'github',
    projectKey: 'acme/api',
    name: 'api',
    checkoutPath: 'repositories/api',
    repoRoot: '/workspace/repositories/api',
    baseBranch: 'main',
    workingBranch: 'afk/work-item-18',
    primary: true,
    ...overrides,
  };
}

function snapshot(branch = 'main'): RepositoryGitSnapshot {
  return {
    branch,
    head: `${branch}-head`,
    status: '',
    workingBranchExisted: false,
  };
}

function dependencies(): MultiRepositoryPreparerDependencies {
  const release = vi.fn(async () => undefined);
  return {
    filesystem: {
      validateRepositoryPath: vi.fn(async () => undefined),
      inspectTarget: vi.fn(async () => 'nonempty'),
      removeTarget: vi.fn(async () => undefined),
    },
    lock: {
      acquire: vi.fn(async () => ({ release })),
    },
    clone: {
      clone: vi.fn(async () => undefined),
    },
    git: {
      isRepository: vi.fn(async () => true),
      originUrl: vi.fn(async repoRoot => repoRoot.endsWith('/web')
        ? 'https://github.com/acme/web.git'
        : 'https://github.com/acme/api.git'),
      capture: vi.fn(async (_repoRoot, workingBranch) => snapshot(workingBranch === 'afk/work-item-18' ? 'main' : 'develop')),
      fetchBase: vi.fn(async () => undefined),
      prepareWorkingBranch: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
    },
  };
}

function lockDependencies(overrides: Partial<WorkspaceLockDependencies> = {}): WorkspaceLockDependencies {
  return {
    ensureDirectory: vi.fn(async () => undefined),
    isSymbolicLink: vi.fn(async () => false),
    createDirectory: vi.fn(async () => undefined),
    writeOwner: vi.fn(async () => undefined),
    readOwner: vi.fn(async () => JSON.stringify({
      pid: 100,
      startedAt: '2026-09-22T01:00:00.000Z',
      token: 'owner',
    })),
    statDirectory: vi.fn(async () => lockStat('2026-09-22T01:00:00.000Z')),
    rename: vi.fn(async () => undefined),
    removeDirectory: vi.fn(async () => undefined),
    processAlive: vi.fn(async () => true),
    pid: 100,
    now: () => new Date('2026-09-22T01:00:00.000Z'),
    ownerId: () => 'owner',
    uniqueId: () => 'unique',
    initializationGraceMs: 30_000,
    ...overrides,
  };
}

function lockStat(iso: string) {
  const timestamp = Date.parse(iso);
  return { ino: 4242, birthtimeMs: timestamp, mtimeMs: timestamp };
}

describe('MultiRepositoryPreparer', () => {
  it('builds GitLab clone URLs only from an explicit provider host', () => {
    expect(cloneUrl(repository({ platform: 'gitlab', projectKey: 'team.platform/subgroup/repo' })))
      .toBe('https://gitlab.com/team.platform/subgroup/repo.git');
    expect(cloneUrl(repository({
      platform: 'gitlab', projectKey: 'git.corp/team.platform/subgroup/repo', providerHost: 'git.corp',
    }))).toBe('https://git.corp/team.platform/subgroup/repo.git');
  });

  it('does not reclaim an initializing lock directory with no owner inside the grace period', async () => {
    const rename = vi.fn(async () => undefined);
    const deps = lockDependencies({
      createDirectory: vi.fn(async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }),
      readOwner: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
      statDirectory: vi.fn(async () => lockStat('2026-09-22T00:59:50.000Z')),
      rename,
    });

    await expect(acquireWorkspaceLock('/workspace', deps)).rejects.toThrow('already locked');
    expect(rename).not.toHaveBeenCalled();
  });

  it('atomically quarantines and reclaims a stale empty lock directory', async () => {
    let locked = true;
    let owner: string | undefined;
    const rename = vi.fn(async (from: string) => {
      if (!locked) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      expect(from).toBe('/workspace/.afk/multi-repository-preparation.lock');
      locked = false;
    });
    const removeDirectory = vi.fn(async () => undefined);
    const deps = lockDependencies({
      createDirectory: vi.fn(async () => {
        if (locked) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        locked = true;
      }),
      writeOwner: vi.fn(async (_path, contents) => { owner = contents; }),
      readOwner: vi.fn(async () => {
        if (!owner) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return owner;
      }),
      statDirectory: vi.fn(async () => lockStat('2026-09-22T00:00:00.000Z')),
      rename,
      removeDirectory,
      uniqueId: vi.fn().mockReturnValueOnce('stale').mockReturnValueOnce('release'),
    });

    const lock = await acquireWorkspaceLock('/workspace', deps);
    expect(rename).toHaveBeenNthCalledWith(1,
      '/workspace/.afk/multi-repository-preparation.lock',
      expect.stringMatching(/^\/workspace\/\.afk\/multi-repository-preparation\.stale-[a-f0-9]{24}$/));
    expect(removeDirectory).not.toHaveBeenCalled();

    await lock.release();
    expect(rename).toHaveBeenNthCalledWith(2,
      '/workspace/.afk/multi-repository-preparation.lock',
      '/workspace/.afk/multi-repository-preparation.lock.release-stale');
  });

  it('allows only one of two stale-lock reclaimers to win the quarantine rename', async () => {
    let locked = true;
    let owner: string | undefined;
    let renameArrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
    const rename = vi.fn(async () => {
      renameArrivals += 1;
      if (renameArrivals === 2) releaseBarrier();
      await barrier;
      if (!locked) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      locked = false;
    });
    const shared = {
      createDirectory: vi.fn(async () => {
        if (locked) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        locked = true;
      }),
      writeOwner: vi.fn(async (_path: string, contents: string) => { owner = contents; }),
      readOwner: vi.fn(async () => {
        if (!owner) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return owner;
      }),
      statDirectory: vi.fn(async () => lockStat('2026-09-22T00:00:00.000Z')),
      rename,
      removeDirectory: vi.fn(async () => undefined),
      processAlive: vi.fn(async () => true),
    };
    const first = acquireWorkspaceLock('/workspace', lockDependencies({ ...shared, ownerId: () => 'first', uniqueId: () => 'first' }));
    const second = acquireWorkspaceLock('/workspace', lockDependencies({ ...shared, ownerId: () => 'second', uniqueId: () => 'second' }));

    const results = await Promise.allSettled([first, second]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(rename).toHaveBeenCalledTimes(2);
    await (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it('prevents a delayed stale observer from moving the newly rebuilt lock', async () => {
    let currentOwner = JSON.stringify({
      pid: 42,
      startedAt: '2026-09-22T00:00:00.000Z',
      token: 'stale-generation',
    });
    const tombstones = new Set<string>();
    let resolveFirstRebuilt!: () => void;
    const firstRebuilt = new Promise<void>(resolve => { resolveFirstRebuilt = resolve; });
    const performRename = async (to: string) => {
      if (tombstones.has(to)) throw Object.assign(new Error('tombstone exists'), { code: 'EEXIST' });
      tombstones.add(to);
      currentOwner = '';
    };
    const shared = {
      createDirectory: vi.fn(async () => {
        if (currentOwner !== '') throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }),
      readOwner: vi.fn(async () => currentOwner),
      statDirectory: vi.fn(async () => lockStat('2026-09-22T00:00:00.000Z')),
      removeDirectory: vi.fn(async (path: string) => { tombstones.delete(path); }),
      processAlive: vi.fn(async (pid: number) => pid === 100),
    };
    const first = acquireWorkspaceLock('/workspace', lockDependencies({
      ...shared,
      ownerId: () => 'first-owner',
      uniqueId: () => 'first',
      rename: vi.fn(async (_from: string, to: string) => performRename(to)),
      writeOwner: vi.fn(async (_path, contents) => {
        currentOwner = contents;
        resolveFirstRebuilt();
      }),
    }));
    const second = acquireWorkspaceLock('/workspace', lockDependencies({
      ...shared,
      ownerId: () => 'second-owner',
      uniqueId: () => 'second',
      rename: vi.fn(async (_from: string, to: string) => {
        await firstRebuilt;
        await performRename(to);
      }),
      writeOwner: vi.fn(async (_path, contents) => { currentOwner = contents; }),
    }));

    const results = await Promise.allSettled([first, second]);

    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(currentOwner).toContain('first-owner');
  });

  it('renames a stale lock after one owner read without a read-delete window', async () => {
    let locked = true;
    const readOwner = vi.fn(async () => JSON.stringify({
      pid: 42,
      startedAt: '2026-09-22T00:00:00.000Z',
      token: 'stale',
    }));
    const deps = lockDependencies({
      createDirectory: vi.fn(async () => {
        if (locked) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        locked = true;
      }),
      readOwner,
      processAlive: vi.fn(async () => false),
      rename: vi.fn(async () => { locked = false; }),
    });

    await acquireWorkspaceLock('/workspace', deps);

    expect(readOwner).toHaveBeenCalledTimes(1);
    expect(deps.rename).toHaveBeenCalledTimes(1);
  });

  it('reclaims corrupt owner metadata only after the initialization grace period', async () => {
    let locked = true;
    const deps = lockDependencies({
      createDirectory: vi.fn(async () => {
        if (locked) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        locked = true;
      }),
      readOwner: vi.fn(async () => '{half-written'),
      statDirectory: vi.fn(async () => lockStat('2026-09-22T00:00:00.000Z')),
      rename: vi.fn(async () => { locked = false; }),
    });

    await acquireWorkspaceLock('/workspace', deps);

    expect(deps.rename).toHaveBeenCalledTimes(1);
    expect(deps.processAlive).not.toHaveBeenCalled();
  });

  it('does not release a replacement lock with another token', async () => {
    let owner = '';
    const rename = vi.fn(async () => undefined);
    const lock = await acquireWorkspaceLock('/workspace', lockDependencies({
      writeOwner: vi.fn(async (_path, contents) => { owner = contents; }),
      readOwner: vi.fn(async () => owner),
      rename,
    }));
    owner = JSON.stringify({ pid: 200, startedAt: '2026-09-22T02:00:00.000Z', token: 'replacement' });

    await Promise.all([lock.release(), lock.release()]);

    expect(rename).not.toHaveBeenCalled();
  });

  it('releases its owned lock directory only once across concurrent finish calls', async () => {
    const rename = vi.fn(async () => undefined);
    const removeDirectory = vi.fn(async () => undefined);
    const lock = await acquireWorkspaceLock('/workspace', lockDependencies({ rename, removeDirectory }));

    await Promise.all([lock.release(), lock.release()]);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledTimes(1);
  });

  it('moves and cleans its newly created directory when owner metadata writing fails', async () => {
    const rename = vi.fn(async () => undefined);
    const removeDirectory = vi.fn(async () => undefined);
    const failure = new Error('owner write failed');

    await expect(acquireWorkspaceLock('/workspace', lockDependencies({
      writeOwner: vi.fn(async () => { throw failure; }),
      rename,
      removeDirectory,
    }))).rejects.toBe(failure);

    expect(rename).toHaveBeenCalledWith(
      '/workspace/.afk/multi-repository-preparation.lock',
      expect.stringMatching(/^\/workspace\/\.afk\/multi-repository-preparation\.stale-[a-f0-9]{24}$/),
    );
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it('prepares repositories in manifest order using each base branch and one working branch', async () => {
    const deps = dependencies();
    vi.mocked(deps.git.originUrl).mockResolvedValueOnce('https://github.com/acme/api.git')
      .mockResolvedValueOnce('https://gitlab.com/gitlab.example.com/acme/web.git');
    const repositories = [
      repository(),
      repository({
        projectKey: 'gitlab.example.com/acme/web',
        platform: 'gitlab',
        name: 'web',
        checkoutPath: 'repositories/web',
        repoRoot: '/workspace/repositories/web',
        baseBranch: 'develop',
        primary: false,
      }),
    ];

    const prepared = await new MultiRepositoryPreparer(deps).prepare(repositories, '/workspace');

    expect(deps.git.fetchBase).toHaveBeenNthCalledWith(1, repositories[0].repoRoot, 'main');
    expect(deps.git.fetchBase).toHaveBeenNthCalledWith(2, repositories[1].repoRoot, 'develop');
    expect(deps.git.prepareWorkingBranch).toHaveBeenNthCalledWith(1, repositories[0].repoRoot, 'main', 'afk/work-item-18');
    expect(deps.git.prepareWorkingBranch).toHaveBeenNthCalledWith(2, repositories[1].repoRoot, 'develop', 'afk/work-item-18');
    expect(prepared.repositories.map(item => item.repoRoot)).toEqual(repositories.map(item => item.repoRoot));
    expect(prepared.primary.repoRoot).toBe(repositories[0].repoRoot);
    expect(prepared.primary.handle).toEqual({ branch: 'afk/work-item-18', path: repositories[0].repoRoot, isNewBranch: true });
  });

  it('rejects a mismatched or local origin before touching the checkout', async () => {
    for (const origin of ['https://github.com/other/api.git', '/tmp/other.git', 'file:///tmp/api.git']) {
      const deps = dependencies();
      vi.mocked(deps.git.originUrl).mockResolvedValue(origin);
      await expect(new MultiRepositoryPreparer(deps).prepare([repository()], '/workspace')).rejects.toThrow('origin does not match');
      expect(deps.git.capture).not.toHaveBeenCalled();
      expect(deps.git.fetchBase).not.toHaveBeenCalled();
      expect(deps.git.restore).not.toHaveBeenCalled();
    }
  });

  it('normalizes HTTPS, SSH and scp remotes against the manifest identity', () => {
    const target = repository();
    expect(() => assertRepositoryOrigin(target, 'git@github.com:acme/api.git')).not.toThrow();
    expect(() => assertRepositoryOrigin(target, 'ssh://git@github.com/acme/api.git')).not.toThrow();
    expect(() => assertRepositoryOrigin(target, 'https://github.com/ACME/API.git')).not.toThrow();
    expect(() => assertRepositoryOrigin(repository({ platform: 'gitlab', projectKey: 'git.corp/team/api', providerHost: 'git.corp' }),
      'git@git.corp:team/api.git')).not.toThrow();
  });

  it('rolls back earlier repositories in reverse order when later preparation fails', async () => {
    const deps = dependencies();
    const first = repository();
    const second = repository({
      projectKey: 'acme/web', name: 'web', checkoutPath: 'repositories/web',
      repoRoot: '/workspace/repositories/web', baseBranch: 'develop', primary: false,
    });
    vi.mocked(deps.git.prepareWorkingBranch)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('prepare web failed'));

    await expect(new MultiRepositoryPreparer(deps).prepare([first, second], '/workspace')).rejects.toThrow('prepare web failed');

    expect(deps.git.restore).toHaveBeenCalledTimes(2);
    expect(deps.git.restore).toHaveBeenNthCalledWith(1, second.repoRoot, expect.any(Object), second.workingBranch);
    expect(deps.git.restore).toHaveBeenNthCalledWith(2, first.repoRoot, expect.any(Object), first.workingBranch);
  });

  it('removes a newly cloned checkout when later preparation fails', async () => {
    const deps = dependencies();
    const first = repository();
    const second = repository({
      projectKey: 'acme/web', name: 'web', checkoutPath: 'repositories/web',
      repoRoot: '/workspace/repositories/web', primary: false,
    });
    vi.mocked(deps.filesystem.inspectTarget).mockResolvedValueOnce('missing').mockResolvedValueOnce('nonempty');
    vi.mocked(deps.git.prepareWorkingBranch).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('prepare web failed'));

    await expect(new MultiRepositoryPreparer(deps).prepare([first, second], '/workspace')).rejects.toThrow('prepare web failed');

    expect(deps.filesystem.removeTarget).toHaveBeenCalledTimes(1);
    expect(deps.filesystem.removeTarget).toHaveBeenCalledWith(first.repoRoot);
    expect(deps.git.restore).toHaveBeenCalledTimes(1);
    expect(deps.git.restore).toHaveBeenCalledWith(second.repoRoot, expect.any(Object), second.workingBranch);
  });

  it('finalizes all repositories and cleans them once across concurrent success finishes', async () => {
    const deps = dependencies();
    const repositories = [
      repository(),
      repository({ projectKey: 'acme/web', name: 'web', checkoutPath: 'repositories/web', repoRoot: '/workspace/repositories/web', primary: false }),
    ];
    const prepared = await new MultiRepositoryPreparer(deps).prepare(repositories, '/workspace');

    await Promise.all([
      prepared.finish({ status: 'success' }),
      prepared.finish({ status: 'success' }),
    ]);

    expect(deps.git.finalize).toHaveBeenCalledTimes(2);
    expect(deps.git.finalize).toHaveBeenNthCalledWith(1, repositories[0].repoRoot, repositories[0].workingBranch);
    expect(deps.git.finalize).toHaveBeenNthCalledWith(2, repositories[1].repoRoot, repositories[1].workingBranch);
    expect(deps.git.restore).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'timeout', 'handoff', 'crashed'] as const)('preserves edits without finalizing on %s finish', async status => {
    const deps = dependencies();
    const prepared = await new MultiRepositoryPreparer(deps).prepare([repository()], '/workspace');
    const lock = await vi.mocked(deps.lock.acquire).mock.results[0].value;

    await Promise.all([
      prepared.finish({ status }),
      prepared.finish({ status }),
    ]);

    expect(deps.git.finalize).not.toHaveBeenCalled();
    expect(deps.git.restore).not.toHaveBeenCalled();
    expect(deps.filesystem.removeTarget).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('preserves clones created by this run and pre-existing repositories on failed finish', async () => {
    const deps = dependencies();
    vi.mocked(deps.filesystem.inspectTarget)
      .mockResolvedValueOnce('missing')
      .mockResolvedValueOnce('nonempty');
    const cloned = repository();
    const existing = repository({
      projectKey: 'acme/web', name: 'web', checkoutPath: 'repositories/web',
      repoRoot: '/workspace/repositories/web', primary: false,
    });
    const prepared = await new MultiRepositoryPreparer(deps).prepare([cloned, existing], '/workspace');

    await prepared.finish({ status: 'failed' });

    expect(deps.clone.clone).toHaveBeenCalledWith('https://github.com/acme/api.git', cloned.repoRoot);
    expect(deps.filesystem.removeTarget).not.toHaveBeenCalled();
    expect(deps.git.restore).not.toHaveBeenCalled();
  });

  it('removes newly cloned checkouts after successful finalization', async () => {
    const deps = dependencies();
    vi.mocked(deps.filesystem.inspectTarget).mockResolvedValue('missing');
    const target = repository();
    const prepared = await new MultiRepositoryPreparer(deps).prepare([target], '/workspace');

    await prepared.finish({ status: 'success' });

    expect(deps.git.finalize).toHaveBeenCalledTimes(1);
    expect(deps.git.finalize).toHaveBeenCalledWith(target.repoRoot, target.workingBranch);
    expect(deps.filesystem.removeTarget).toHaveBeenCalledTimes(1);
    expect(deps.filesystem.removeTarget).toHaveBeenCalledWith(target.repoRoot);
    expect(deps.git.restore).not.toHaveBeenCalled();
  });

  it('rejects a dirty pre-existing repository without resetting user changes', async () => {
    const deps = dependencies();
    vi.mocked(deps.git.capture).mockResolvedValue({
      branch: 'main', head: 'main-head', status: ' M src/user-change.ts', workingBranchExisted: false,
    });

    await expect(new MultiRepositoryPreparer(deps).prepare([repository()], '/workspace')).rejects.toThrow('uncommitted changes');

    expect(deps.git.fetchBase).not.toHaveBeenCalled();
    expect(deps.git.prepareWorkingBranch).not.toHaveBeenCalled();
    expect(deps.git.restore).not.toHaveBeenCalled();
    expect(deps.filesystem.removeTarget).not.toHaveBeenCalled();
  });

  it('defensively requires exactly one primary repository', async () => {
    const deps = dependencies();
    const preparer = new MultiRepositoryPreparer(deps);

    await expect(preparer.prepare([repository({ primary: false })], '/workspace')).rejects.toThrow('exactly one primary');
    await expect(preparer.prepare([
      repository(),
      repository({ projectKey: 'acme/web', repoRoot: '/workspace/repositories/web' }),
    ], '/workspace')).rejects.toThrow('exactly one primary');
    expect(deps.git.fetchBase).not.toHaveBeenCalled();
  });

  it('defensively requires one shared working branch', async () => {
    const deps = dependencies();

    await expect(new MultiRepositoryPreparer(deps).prepare([
      repository(),
      repository({
        projectKey: 'acme/web', repoRoot: '/workspace/repositories/web', primary: false,
        workingBranch: 'afk/other-work-item',
      }),
    ], '/workspace')).rejects.toThrow('same working branch');

    expect(deps.git.fetchBase).not.toHaveBeenCalled();
  });

  it('restores and cleans a real existing repository after success finish', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-multi-repo-'));
    try {
      const remote = join(root, 'remote.git');
      const seed = join(root, 'seed');
      const repoRoot = join(root, 'existing');
      await fs.mkdir(remote);
      await simpleGit(remote).init(true);
      await fs.mkdir(seed);
      const seedGit = simpleGit(seed);
      await seedGit.init(['--initial-branch=main']);
      await seedGit.addConfig('user.name', 'AFK Test');
      await seedGit.addConfig('user.email', 'afk@example.test');
      await fs.writeFile(join(seed, '.gitignore'), 'ignored.log\n');
      await fs.writeFile(join(seed, 'tracked.txt'), 'baseline\n');
      await seedGit.add(['.gitignore', 'tracked.txt']);
      await seedGit.commit('baseline');
      await seedGit.addRemote('origin', remote);
      await seedGit.push('origin', 'main', ['--set-upstream']);
      await simpleGit().clone(remote, repoRoot, ['--branch', 'main']);
      await configureLocalOrigin(repoRoot, remote, 'https://github.com/acme/api.git');
      const originalHead = (await simpleGit(repoRoot).revparse(['HEAD'])).trim();
      await fs.writeFile(join(repoRoot, 'ignored.log'), 'keep me\n');

      const prepared = await new MultiRepositoryPreparer().prepare([
        repository({ repoRoot }),
      ], root);
      await fs.writeFile(join(repoRoot, 'generated.tmp'), 'remove me\n');

      await prepared.finish({ status: 'success' });

      await expect(fs.access(join(repoRoot, 'generated.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(join(repoRoot, 'ignored.log'), 'utf8')).resolves.toBe('keep me\n');
      expect((await simpleGit(repoRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');
      expect((await simpleGit(repoRoot).revparse(['HEAD'])).trim()).toBe(originalHead);
      await expect(fs.access(repoRoot)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('holds one workspace lock until idempotent finish releases it once', async () => {
    const deps = dependencies();
    const prepared = await new MultiRepositoryPreparer(deps).prepare([repository()], '/workspace');
    const lock = await vi.mocked(deps.lock.acquire).mock.results[0].value;

    await Promise.all([prepared.finish({ status: 'failed' }), prepared.finish({ status: 'success' })]);

    expect(deps.lock.acquire).toHaveBeenCalledWith('/workspace');
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('releases the workspace lock when preparation fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.git.prepareWorkingBranch).mockRejectedValue(new Error('prepare failed'));
    const lock = await vi.mocked(deps.lock.acquire).mock.results[0]?.value;

    await expect(new MultiRepositoryPreparer(deps).prepare([repository()], '/workspace')).rejects.toThrow('prepare failed');

    const acquired = lock ?? await vi.mocked(deps.lock.acquire).mock.results[0].value;
    expect(acquired.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a concurrent workspace lock before touching repository targets', async () => {
    const deps = dependencies();
    vi.mocked(deps.lock.acquire).mockRejectedValue(new Error('workspace preparation is already locked'));

    await expect(new MultiRepositoryPreparer(deps).prepare([repository()], '/workspace'))
      .rejects.toThrow('already locked');

    expect(deps.filesystem.inspectTarget).not.toHaveBeenCalled();
    expect(deps.git.isRepository).not.toHaveBeenCalled();
  });

  it('preserves every repository when any success finalization fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.filesystem.inspectTarget).mockResolvedValueOnce('missing').mockResolvedValueOnce('nonempty');
    vi.mocked(deps.git.finalize).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('push failed'));
    const prepared = await new MultiRepositoryPreparer(deps).prepare([
      repository(),
      repository({ projectKey: 'acme/web', repoRoot: '/workspace/repositories/web', primary: false }),
    ], '/workspace');

    await expect(prepared.finish({ status: 'success' })).rejects.toThrow('push failed');
    await expect(prepared.finish({ status: 'success' })).rejects.toThrow('push failed');

    expect(deps.git.finalize).toHaveBeenCalledTimes(2);
    expect(deps.filesystem.removeTarget).not.toHaveBeenCalled();
    expect(deps.git.restore).not.toHaveBeenCalled();
  });

  it('rejects a repository symlink escaping the workspace without touching the external repository', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-symlink-workspace-'));
    const external = await fs.mkdtemp(join(tmpdir(), 'afk-symlink-external-'));
    try {
      const git = simpleGit(external);
      await git.init(['--initial-branch=main']);
      await git.addConfig('user.name', 'AFK Test');
      await git.addConfig('user.email', 'afk@example.test');
      await fs.writeFile(join(external, 'protected.txt'), 'unchanged\n');
      await git.add('protected.txt');
      await git.commit('baseline');
      const originalHead = (await git.revparse(['HEAD'])).trim();
      const repoRoot = join(root, 'repositories', 'api');
      await fs.mkdir(join(root, 'repositories'), { recursive: true });
      await fs.symlink(external, repoRoot);

      await expect(new MultiRepositoryPreparer().prepare([repository({ repoRoot })], root))
        .rejects.toThrow(/symbolic link|workspace/i);

      expect((await git.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');
      expect((await git.revparse(['HEAD'])).trim()).toBe(originalHead);
      await expect(fs.readFile(join(external, 'protected.txt'), 'utf8')).resolves.toBe('unchanged\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  it('atomically rejects a second real preparation in the same workspace', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-lock-workspace-'));
    try {
      const remote = join(root, 'remote.git');
      const seed = join(root, 'seed');
      const repoRoot = join(root, 'repositories', 'api');
      await fs.mkdir(remote);
      await simpleGit(remote).init(true);
      await fs.mkdir(seed);
      const seedGit = simpleGit(seed);
      await seedGit.init(['--initial-branch=main']);
      await seedGit.addConfig('user.name', 'AFK Test');
      await seedGit.addConfig('user.email', 'afk@example.test');
      await fs.writeFile(join(seed, 'tracked.txt'), 'baseline\n');
      await seedGit.add('tracked.txt');
      await seedGit.commit('baseline');
      await seedGit.addRemote('origin', remote);
      await seedGit.push('origin', 'main', ['--set-upstream']);
      await fs.mkdir(dirname(repoRoot), { recursive: true });
      await simpleGit().clone(remote, repoRoot, ['--branch', 'main']);
      await configureLocalOrigin(repoRoot, remote, 'https://github.com/acme/api.git');
      const input = [repository({ repoRoot })];

      const first = await new MultiRepositoryPreparer().prepare(input, root);
      const branchBefore = (await simpleGit(repoRoot).revparse(['--abbrev-ref', 'HEAD'])).trim();
      const headBefore = (await simpleGit(repoRoot).revparse(['HEAD'])).trim();

      await expect(new MultiRepositoryPreparer().prepare(input, root)).rejects.toThrow('already locked');
      expect((await simpleGit(repoRoot).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(branchBefore);
      expect((await simpleGit(repoRoot).revparse(['HEAD'])).trim()).toBe(headBefore);

      await first.finish({ status: 'failed' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function configureLocalOrigin(repoRoot: string, remote: string, url: string): Promise<void> {
  const git = simpleGit(repoRoot);
  await git.raw(['config', '--local', `url.${remote}.insteadOf`, url]);
  await git.raw(['remote', 'set-url', 'origin', url]);
}
