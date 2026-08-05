import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '../workflows';
import type { ProviderBundle } from '../core/providers';
import type { BacklogClaim, BacklogItem } from '../core/backlog';
import type { AgentProvider } from '../agents/types';

vi.mock('../modules/project-resolver', () => ({ default: () => ({ name: 'project-resolver' }) }));

const item: BacklogItem = {
  id: '42', title: 'Item', dependsOn: [], state: 'in_progress', executionMode: 'afk',
  branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42',
};

function providers(claim: ReturnType<typeof vi.fn>): ProviderBundle {
  return {
    backlog: {
      claim, transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
      get: vi.fn(async () => item), list: vi.fn(async () => []), isRunnable: vi.fn(async () => true),
    },
    branches: { createBranch: vi.fn(), push: vi.fn(), commit: vi.fn(), cleanup: vi.fn() },
    changes: { create: vi.fn(), get: vi.fn(), findForBacklog: vi.fn(), merge: vi.fn(), close: vi.fn() },
  } as unknown as ProviderBundle;
}

function claimed(itemToClaim = item): { claim: BacklogClaim; release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => {});
  return {
    claim: {
      item: itemToClaim,
      claimId: 'claim-42',
      heartbeat: async () => {},
      release,
    },
    release,
  };
}

function runner(bundle: ProviderBundle): WorkflowRunner {
  const agent = { name: 'claude-code', capabilities: new Set(), buildCommand: () => ({ argv: ['echo'], env: {} }) } as unknown as AgentProvider;
  return new WorkflowRunner(bundle, { agentProvider: agent });
}

describe('WorkflowRunner backlog provider mode', () => {
  it('claims backlog before execution and transitions a successful run to verification', async () => {
    const { claim: backlogClaim, release } = claimed();
    const claim = vi.fn(async () => backlogClaim);
    const bundle = providers(claim);
    const subject = runner(bundle) as any;
    subject.runBody = vi.fn(async () => ({ success: true, url: 'https://change/1' }));

    await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' })).resolves.toMatchObject({ success: true });
    expect(claim).toHaveBeenCalledWith('42', 'worker-a');
    expect(bundle.backlog.transition).toHaveBeenCalledWith('42', 'verification', undefined);
    expect(subject.activeBacklog).toBe(item);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('skips a backlog that was not atomically claimed', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    subject.runBody = vi.fn();

    await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' })).resolves.toEqual({ success: false });
    expect(subject.runBody).not.toHaveBeenCalled();
  });

  it('marks an unsuccessful run blocked and hitl', async () => {
    const { claim, release } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const subject = runner(bundle) as any;
    subject.runBody = vi.fn(async () => ({ success: false }));

    await subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' });
    expect(bundle.backlog.transition).toHaveBeenCalledWith('42', 'blocked', { reason: 'workflow execution failed' });
    expect(bundle.backlog.setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a claimed lease exactly once when cleanup and the run terminalizer race', async () => {
    const { claim, release } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const subject = runner(bundle) as any;
    subject.runBody = vi.fn(async () => {
      await Promise.all([
        subject.resourceScope.finish({ status: 'failed' }),
        subject.resourceScope.finish({ status: 'crashed' }),
      ]);
      return { success: false };
    });

    await subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a claim when setup fails after acquisition', async () => {
    const { claim, release } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const subject = runner(bundle) as any;
    subject.sandboxProviderByName = vi.fn(() => { throw new Error('sandbox setup failed'); });

    await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' })).rejects.toThrow('sandbox setup failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not transition a successful run to verification after lease heartbeat loss', async () => {
    vi.useFakeTimers();
    try {
      const { claim, release } = claimed();
      claim.heartbeat = vi.fn(async () => { throw new Error('lease lost'); });
      const bundle = providers(vi.fn(async () => claim));
      const subject = runner(bundle) as any;
      subject.runBody = vi.fn(async () => {
        await vi.advanceTimersByTimeAsync(1);
        return { success: true };
      });

      await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main', claimHeartbeatIntervalMs: 1 })).resolves.toEqual({ success: false });
      expect(bundle.backlog.transition).toHaveBeenCalledWith('42', 'blocked', expect.anything());
      expect(bundle.backlog.transition).not.toHaveBeenCalledWith('42', 'verification', undefined);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a claim when heartbeat interval setup is invalid', async () => {
    const { claim, release } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const subject = runner(bundle) as any;

    await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main', claimHeartbeatIntervalMs: 0 })).rejects.toThrow('heartbeat interval');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
