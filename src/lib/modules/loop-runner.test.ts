import { describe, expect, it, vi } from 'vitest';
import { LoopRunner } from './loop-runner';
import type { ProviderBundle } from '../core/providers';
import type { BacklogItem } from '../core/backlog';

const item: BacklogItem = {
  id: '42',
  title: 'verify me',
  dependsOn: [],
  state: 'verification',
  executionMode: 'afk',
  tags: [],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
};

describe('LoopRunner QA boundary', () => {
  it('passes a claim-free backlog facade to QARunner', async () => {
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async () => item),
        list: vi.fn(async () => []),
        claim: vi.fn(),
        transition: vi.fn(async () => {}),
        setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}),
        removeTag: vi.fn(async () => {}),
        initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => false),
      },
      branches: {} as ProviderBundle['branches'],
      changes: {} as ProviderBundle['changes'],
    };
    const qaFactory = vi.fn(() => ({ process: vi.fn(async () => ({ success: true })) }) as any);
    const subject = new LoopRunner(providers, { qaRunnerFactory: qaFactory });
    const internals = subject as any;
    internals.running = true;
    internals.qaQueue.push('42');

    await internals.runQA();

    expect(qaFactory).toHaveBeenCalledTimes(1);
    const managementBundle = qaFactory.mock.calls[0][0];
    expect('claim' in managementBundle.backlog).toBe(false);
    expect(managementBundle.backlog.get).toBeDefined();
    expect(managementBundle.backlog.transition).toBeDefined();
  });

  it('passes main for a root backlog and the parent branch for a child backlog', async () => {
    const root = { ...item, id: '10', branchName: 'afk/backlog-10', parentId: undefined };
    const child = { ...item, id: '42', parentId: '10' };
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async (id: string) => id === '10' ? root : child),
        list: vi.fn(async () => []),
        claim: vi.fn(),
        transition: vi.fn(async () => {}),
        setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}),
        removeTag: vi.fn(async () => {}),
        initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => true),
      },
      branches: {} as ProviderBundle['branches'],
      changes: {} as ProviderBundle['changes'],
    };
    const runs: any[] = [];
    const workflowRunnerFactory = vi.fn(() => ({
      run: vi.fn(async (options: any) => { runs.push(options); return { success: true }; }),
    }) as any);
    const subject = new LoopRunner(providers, { workflowRunnerFactory });
    const internals = subject as any;
    internals.running = true;
    internals.enqueueQA = vi.fn();

    await internals.runChain('42');
    expect(runs[0]).toMatchObject({ targetBranch: 'afk/backlog-10', baseBranch: 'afk/backlog-10' });

    await internals.runChain('10');
    expect(runs[1]).toMatchObject({ targetBranch: 'main', baseBranch: 'main' });
  });

  it('releases a claim-miss reservation without blocking or counting a failure', async () => {
    const ready = { ...item, state: 'ready' as const };
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async () => ready), list: vi.fn(async () => []), claim: vi.fn(),
        transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}), removeTag: vi.fn(async () => {}), initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => true),
      }, branches: {} as ProviderBundle['branches'], changes: {} as ProviderBundle['changes'],
    };
    const workflowRunnerFactory = vi.fn(() => ({
      run: vi.fn(async () => ({ success: false, skipped: 'not_claimed' })),
    }) as any);
    const subject = new LoopRunner(providers, { workflowRunnerFactory });
    const internals = subject as any;
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.runChain('42');

    expect(providers.backlog.transition).not.toHaveBeenCalled();
    expect(providers.backlog.setExecutionMode).not.toHaveBeenCalled();
    expect(internals.getStatus()).toMatchObject({
      implement: { active: 0, ids: [] },
      totals: { started: 0, failed: 0, completed: 0 },
      lastError: {},
    });
    expect(internals.inFlight.has('42')).toBe(false);
    expect(internals.emitEvent).toHaveBeenCalledWith('42 implement skipped (claim unavailable)');
  });

  it('reports root QA success as merge_ready awaiting human approval', async () => {
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async () => item), list: vi.fn(async () => []), claim: vi.fn(),
        transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}), removeTag: vi.fn(async () => {}), initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => false),
      }, branches: {} as ProviderBundle['branches'], changes: {} as ProviderBundle['changes'],
    };
    const subject = new LoopRunner(providers, { qaRunnerFactory: vi.fn(() => ({ process: vi.fn(async () => ({ success: true, autoMerged: false })) }) as any) });
    const internals = subject as any;
    internals.running = true;
    internals.qaQueue.push('42');
    internals.emitEvent = vi.fn();

    await internals.runQA();

    expect(internals.emitEvent).toHaveBeenCalledWith(expect.stringContaining('QA passed → merge_ready (human approval)'));
  });

  it('reports QA rework without misclassifying it as blocked', async () => {
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async () => item), list: vi.fn(async () => []), claim: vi.fn(),
        transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}), removeTag: vi.fn(async () => {}), initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => false),
      }, branches: {} as ProviderBundle['branches'], changes: {} as ProviderBundle['changes'],
    };
    const subject = new LoopRunner(providers, {
      qaRunnerFactory: vi.fn(() => ({ process: vi.fn(async () => ({ success: false, rework: true })) }) as any),
    });
    const internals = subject as any;
    internals.running = true;
    internals.qaQueue.push('42');
    internals.emitEvent = vi.fn();

    await internals.runQA();

    expect(internals.emitEvent).toHaveBeenCalledWith(expect.stringContaining('QA failed → rework/afk'));
    expect(internals.getStatus().totals.failed).toBe(0);
  });
});
