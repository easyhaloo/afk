import { describe, expect, it, vi } from 'vitest';
import { RunResourceScope } from './resource-scope';
import type { BranchHandle, BranchStrategy, BranchStrategyConfig } from '../branches/types';
import { simpleGit } from 'simple-git';

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
});
