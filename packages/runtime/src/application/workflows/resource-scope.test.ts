import { describe, expect, it, vi, type Mock } from 'vitest';
import { RunResourceScope } from './resource-scope.js';
import type { BranchHandle, BranchStrategy, BranchStrategyConfig } from '../../domain/branches/types.js';
import { simpleGit } from 'simple-git';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemClaimLock, type ClaimLease } from '../../domain/backlog/claim.js';

function strategy(): BranchStrategy {
  return {
    kind: 'named',
    resolveBranch: () => 'afk/test',
    prepareWorktree: vi.fn(async () => ({ branch: 'afk/test', path: '/tmp/primary', isNewBranch: true })),
    finalize: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
}

describe('RunResourceScope', () => {
  it('retains failed ownership rollback leases while completing independent releases and preserving the acquisition error', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'scope-rollback-retry-'));
    vi.stubEnv('AFK_STATE_DIR', join(root, 'state'));
    const acquisitionError = new Error('ownership acquisition interrupted');
    const releaseError = Object.assign(new Error('rollback release I/O failed'), { code: 'EIO' });
    const acquired: Array<{ key: string; lease: ClaimLease; release: Mock<[], Promise<void>> }> = [];
    const acquire = FilesystemClaimLock.prototype.acquire;
    const spy = vi.spyOn(FilesystemClaimLock.prototype, 'acquire').mockImplementation(async function(this: FilesystemClaimLock, request) {
      if (acquired.length === 2) throw acquisitionError;
      const lease = (await acquire.call(this, request))!;
      const release = vi.fn(lease.release);
      if (acquired.length === 1) release.mockRejectedValueOnce(releaseError);
      lease.release = release;
      acquired.push({ key: request.key, lease, release });
      return lease;
    });
    const scope = new RunResourceScope({ repoRoot: root, baseBranch: 'main', ownership: { workspaceRoot: root,
      repositories: [{ platform: 'github', projectKey: 'fixture/first' }, { platform: 'github', projectKey: 'fixture/second' }], owner: 'original' } });
    try {
      await expect(scope.acquireOwnership()).rejects.toMatchObject({ errors: [acquisitionError, releaseError] });
      expect(scope.ownershipClaims).toEqual([acquired[1].lease.claimId]);
      expect(await new FilesystemClaimLock().inspect(acquired[0].key)).toBeNull();
      expect(acquired[0].release).toHaveBeenCalledTimes(1);
      await scope.finish({ status: 'failed' });
      expect(scope.ownershipClaims).toHaveLength(0);
      expect(await new FilesystemClaimLock().inspect(acquired[1].key)).toBeNull();
      expect(acquired[0].release).toHaveBeenCalledTimes(1);
      expect(acquired[1].release).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      for (const entry of acquired) await entry.lease.release();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['sandbox', 'step', 'external', 'primary', 'claim'] as const)('retains exclusion and heartbeat until retry confirms %s cleanup', async stage => {
    const root = await fs.mkdtemp(join(tmpdir(), 'scope-cleanup-retry-'));
    vi.stubEnv('AFK_STATE_DIR', join(root, 'state'));
    const failure = new Error(`${stage} cleanup unconfirmed`);
    const branch = strategy();
    const claim = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const step = vi.fn(async () => {});
    const external = vi.fn(async () => {});
    const heartbeat = vi.fn(async () => {});
    const ownership = { workspaceRoot: root, owner: 'original' };
    const scope = new RunResourceScope({ repoRoot: root, baseBranch: 'main', branchStrategy: branch,
      branchConfig: { type: 'named', branch: 'owned' }, ownership, onCleanup: claim });
    const next = new RunResourceScope({ repoRoot: root, baseBranch: 'main', ownership: { ...ownership, owner: 'next' } });
    const operation = { sandbox: close, step, external, primary: vi.mocked(branch.cleanup), claim }[stage];
    operation.mockRejectedValueOnce(failure);
    try {
      await scope.acquireOwnership();
      if (stage === 'primary') scope.adoptPrimary({ branch: 'owned', path: root, isNewBranch: true });
      scope.registerSandbox({ close });
      scope.registerStepHandle({ branch: 'step', path: join(root, 'step'), isNewBranch: true }, step);
      scope.registerExternalResource({ finish: external });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      scope.registerHeartbeat(heartbeat, 10);
      await expect(scope.finish({ status: 'success' })).rejects.toBe(failure);
      expect(scope.ownershipClaims.length).toBeGreaterThan(0);
      await expect(next.acquireOwnership()).rejects.toThrow(/quarantin/);
      await vi.advanceTimersByTimeAsync(20);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      if (stage === 'sandbox' || stage === 'step' || stage === 'primary') expect(external).not.toHaveBeenCalled();
      if (stage !== 'claim') expect(claim).not.toHaveBeenCalled();
      expect(step).toHaveBeenCalledTimes(1);
      await scope.finish({ status: 'failed' });
      await next.acquireOwnership();
      await scope.finish({ status: 'failed' });
      expect(operation).toHaveBeenCalledTimes(2);
      if (stage !== 'step') expect(step).toHaveBeenCalledTimes(1);
      if (stage !== 'external') expect(external).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      await scope.finish({ status: 'failed' }).catch(() => {});
      await next.finish({ status: 'failed' });
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retains claim, steps and external workspace until a failed execution stop is confirmed on retry', async () => {
    const release = vi.fn(async () => {});
    const workspace = { finish: vi.fn(async () => {}) };
    const step = vi.fn(async () => {});
    const sandbox = { close: vi.fn(async () => {}) };
    const kill = vi.fn(async () => {});
    kill.mockRejectedValueOnce(new Error('owned stop failed'));
    const scope = new RunResourceScope({ repoRoot: '/repo', baseBranch: 'main', onCleanup: release });
    scope.registerExecution({ kill });
    scope.registerSandbox(sandbox);
    scope.registerStepHandle({ branch: 'task', path: '/repo/task', isNewBranch: true }, step);
    scope.registerExternalResource(workspace);
    await expect(scope.finish({ status: 'failed' })).rejects.toThrow('owned stop failed');
    expect(release).not.toHaveBeenCalled();
    expect(workspace.finish).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(sandbox.close).toHaveBeenCalledTimes(1);
    await scope.finish({ status: 'failed' });
    await scope.finish({ status: 'failed' });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(workspace.finish).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('keeps durable workspace and repository exclusion beyond heartbeat expiry until legitimate cleanup retry', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'scope-retained-'));
    const other = await fs.mkdtemp(join(tmpdir(), 'scope-contender-'));
    vi.stubEnv('AFK_STATE_DIR', join(root, 'state'));
    const ownership = { workspaceRoot: root, repositories: [{ platform: 'github', projectKey: 'acme/owned' }], owner: 'run-42' };
    const first = new RunResourceScope({ repoRoot: root, baseBranch: 'main', ownership });
    const next = new RunResourceScope({ repoRoot: root, baseBranch: 'main', ownership: { ...ownership, owner: 'run-43' } });
    const elsewhere = new RunResourceScope({ repoRoot: other, baseBranch: 'main', ownership: { ...ownership, workspaceRoot: other, owner: 'run-44' } });
    const kill = vi.fn(async () => {});
    kill.mockRejectedValueOnce(new Error('still running'));
    first.registerExecution({ kill });
    try {
      await first.acquireOwnership();
      await expect(first.finish({ status: 'failed' })).rejects.toThrow('still running');
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 600_001);
      await expect(next.acquireOwnership()).rejects.toThrow(/owned|quarantin/);
      await expect(elsewhere.acquireOwnership()).rejects.toThrow(/owned|quarantin/);
      await first.finish({ status: 'failed' });
      await next.acquireOwnership();
      await next.finish({ status: 'success' });
    } finally {
      vi.restoreAllMocks();
      await first.finish({ status: 'failed' });
      await next.finish({ status: 'failed' });
      await elsewhere.finish({ status: 'failed' });
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('waits for all independent execution stops before reporting the first failure', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const scope = new RunResourceScope({ repoRoot: '/repo', baseBranch: 'main' });
    scope.registerExecution({ kill: async () => { throw new Error('first stop failed'); } });
    scope.registerExecution({ kill: async () => pending });
    let settled = false;
    const stopping = scope.stopExecutions().catch(error => { settled = true; return error; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await stopping).toEqual(new Error('first stop failed'));
  });

  it('finishes successfully only once and cleans owned resources', async () => {
    const branch = strategy();
    const sandbox = { close: vi.fn(async () => {}) };
    const scope = new RunResourceScope({ repoRoot: '/repo', git: simpleGit(), baseBranch: 'main', branchStrategy: branch, branchConfig: { type: 'named', branch: 'afk/test' } });
    await scope.preparePrimary();
    scope.registerSandbox(sandbox as any);
    const step: BranchHandle = { branch: 'afk/step', path: '/tmp/step', isNewBranch: true };
    scope.registerStepHandle(step, branch, { type: 'named', branch: 'afk/step' });
    await Promise.all([scope.finish({ status: 'success' }), scope.finish({ status: 'success' })]);
    expect(branch.finalize).toHaveBeenCalledTimes(1);
    expect(sandbox.close).toHaveBeenCalledTimes(1);
    expect(branch.cleanup).toHaveBeenCalledTimes(2);
  });

  it('keeps primary resources on failure and never deletes borrowed handles', async () => {
    const branch = strategy();
    const scope = new RunResourceScope({ repoRoot: '/repo', git: simpleGit(), baseBranch: 'main', branchStrategy: branch, branchConfig: { type: 'named', branch: 'afk/test' } });
    await scope.preparePrimary();
    scope.registerStepHandle({ branch: 'existing', path: '/tmp/existing', isNewBranch: false }, branch, { type: 'existing', branch: 'existing' });
    await scope.finish({ status: 'failed' });
    expect(branch.finalize).not.toHaveBeenCalled();
    expect(branch.cleanup).toHaveBeenCalledTimes(0);
  });

  it('runs claim cleanup exactly once across concurrent terminal outcomes', async () => {
    const release = vi.fn(async () => {});
    const scope = new RunResourceScope({
      repoRoot: '/repo', git: simpleGit(), baseBranch: 'main', branchStrategy: strategy(),
      branchConfig: { type: 'named', branch: 'afk/test' }, onCleanup: release,
    });

    await Promise.all([scope.finish({ status: 'success' }), scope.finish({ status: 'failed' })]);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('finishes an external resource exactly once across concurrent terminal outcomes', async () => {
    const external = { finish: vi.fn(async () => {}) };
    const scope = new RunResourceScope({ repoRoot: '/repo', baseBranch: 'main', git: simpleGit() });
    scope.registerExternalResource(external);

    await Promise.all([scope.finish({ status: 'success' }), scope.finish({ status: 'failed' })]);

    expect(external.finish).toHaveBeenCalledTimes(1);
    expect(external.finish).toHaveBeenCalledWith({ status: 'success' });
  });

  it('does not let claim cleanup errors mask a terminal resource error', async () => {
    const branch = strategy();
    const release = vi.fn(async () => { throw new Error('lease release failed'); });
    const scope = new RunResourceScope({
      repoRoot: '/repo', git: simpleGit(), baseBranch: 'main', branchStrategy: branch,
      branchConfig: { type: 'named', branch: 'afk/test' }, onCleanup: release,
    });
    await scope.preparePrimary();
    (branch.finalize as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('finalize failed'));

    await expect(scope.finish({ status: 'success' })).rejects.toThrow('finalize failed');
    expect(release).not.toHaveBeenCalled();
    await expect(scope.finish({ status: 'success' })).rejects.toThrow('lease release failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('heartbeats on an interval and stops the timer exactly once at finish', async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn(async () => {});
      const scope = new RunResourceScope({ repoRoot: '/repo', baseBranch: 'main', git: simpleGit() });
      scope.registerHeartbeat(heartbeat, 10);

      await vi.advanceTimersByTimeAsync(25);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      await scope.finish({ status: 'success' });
      await vi.advanceTimersByTimeAsync(50);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes heartbeat failures to the error hook once and still finishes cleanup', async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn(async () => { throw new Error('lease expired'); });
      const onError = vi.fn(async () => {});
      const scope = new RunResourceScope({ repoRoot: '/repo', baseBranch: 'main', git: simpleGit() });
      scope.registerHeartbeat(heartbeat, 10, onError);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(50);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      await scope.finish({ status: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues cleaning remaining step handles while preserving the first cleanup error', async () => {
    const branch = strategy();
    (branch.cleanup as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('first cleanup failed'))
      .mockResolvedValue(undefined);
    const scope = new RunResourceScope({ repoRoot: '/repo', git: simpleGit(), baseBranch: 'main', branchStrategy: branch, branchConfig: { type: 'named', branch: 'afk/test' } });
    scope.registerStepHandle({ branch: 'afk/one', path: '/tmp/one', isNewBranch: true }, branch, { type: 'named', branch: 'afk/one' });
    scope.registerStepHandle({ branch: 'afk/two', path: '/tmp/two', isNewBranch: true }, branch, { type: 'named', branch: 'afk/two' });

    await expect(scope.finish({ status: 'success' })).rejects.toThrow('first cleanup failed');
    expect(branch.cleanup).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'timeout', 'crashed'] as const)('closes step sandboxes and worktrees once on %s', async status => {
    const branch = strategy();
    const sandbox = { close: vi.fn(async () => {}) };
    const scope = new RunResourceScope({ repoRoot: '/repo', git: simpleGit(), baseBranch: 'main' });
    scope.registerSandbox(sandbox);
    scope.registerStepHandle(
      { branch: 'afk/step', path: '/tmp/step', isNewBranch: true },
      () => branch.cleanup(simpleGit(), { type: 'named', branch: 'afk/step' }, { branch: 'afk/step', path: '/tmp/step', isNewBranch: true }, { force: true }),
    );

    await scope.finish({ status });

    expect(sandbox.close).toHaveBeenCalledTimes(1);
    expect(branch.cleanup).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup after sandbox failure and preserves the first error', async () => {
    const branch = strategy();
    const failedSandbox = { close: vi.fn(async () => { throw new Error('sandbox close failed'); }) };
    const remainingSandbox = { close: vi.fn(async () => {}) };
    const scope = new RunResourceScope({ repoRoot: '/repo', git: simpleGit(), baseBranch: 'main' });
    scope.registerSandbox(remainingSandbox);
    scope.registerSandbox(failedSandbox);
    scope.registerStepHandle(
      { branch: 'afk/step', path: '/tmp/step', isNewBranch: true },
      () => branch.cleanup(simpleGit(), { type: 'named', branch: 'afk/step' }, { branch: 'afk/step', path: '/tmp/step', isNewBranch: true }, { force: true }),
    );

    await expect(scope.finish({ status: 'failed' })).rejects.toThrow('sandbox close failed');
    expect(failedSandbox.close).toHaveBeenCalledTimes(1);
    expect(remainingSandbox.close).toHaveBeenCalledTimes(1);
    expect(branch.cleanup).toHaveBeenCalledTimes(1);
  });
});
