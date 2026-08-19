import { describe, expect, it, vi } from 'vitest';
import { LoopRunner } from './loop-runner';
import type { ProviderBundle } from '../providers';
import type { BacklogItem } from '../../domain/backlog/index';

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
  it('propagates one explicit agent provider through implementation and QA', async () => {
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async () => item), list: vi.fn(async () => []), claim: vi.fn(),
        transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}), removeTag: vi.fn(async () => {}), initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => true),
      }, branches: {} as ProviderBundle['branches'], changes: {} as ProviderBundle['changes'],
    };
    const agentRuntime = Object.freeze({
      kind: 'codex', transport: 'app-server', auth: 'chatgpt', provider: 'openai',
      endpoint: 'stdio://', startupTimeoutMs: 5_000,
    } as const);
    const run = vi.fn(async () => ({ success: true }));
    const workflowFactory = vi.fn(() => ({ run }) as any);
    const qaFactory = vi.fn(() => ({ process: vi.fn(async () => ({ success: true })) }) as any);
    const subject = new LoopRunner(providers, {
      agentProvider: 'codex',
      agentRuntime,
      workflowRunnerFactory: workflowFactory,
      qaRunnerFactory: qaFactory,
    });
    const internals = subject as any;
    internals.running = true;
    internals.emitEvent = vi.fn();
    internals.enqueueQA = vi.fn();

    await internals.runChain('42');
    internals.qaQueue.push('42');
    await internals.runQA();

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ agentProvider: 'codex' }));
    expect(workflowFactory.mock.calls[0][2]).toBe(agentRuntime);
    expect(qaFactory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentDefault: 'codex' }),
      agentRuntime,
    );
  });

  it('fails readiness before polling or claiming a backlog', async () => {
    const backlog = {
      get: vi.fn(), list: vi.fn(), claim: vi.fn(), transition: vi.fn(), setExecutionMode: vi.fn(),
      addTag: vi.fn(), removeTag: vi.fn(), initialize: vi.fn(), isRunnable: vi.fn(),
    };
    const providers = {
      backlog, branches: {} as ProviderBundle['branches'], changes: {} as ProviderBundle['changes'],
    } as ProviderBundle;
    const subject = new LoopRunner(providers, {
      agentProvider: 'codex',
      agentRuntime: {
        kind: 'codex', transport: 'exec', auth: 'api', provider: 'openai', startupTimeoutMs: 5_000,
      },
      readinessProbe: vi.fn(async () => ({
        ready: false as const, code: 'AUTH_INVALID' as const, message: 'Codex authentication is not ready',
      })),
    });

    await expect(Promise.race([
      subject.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('readiness was not checked')), 25)),
    ])).rejects.toThrow(/authentication/i);

    expect(backlog.list).not.toHaveBeenCalled();
    expect(backlog.claim).not.toHaveBeenCalled();
    expect(backlog.transition).not.toHaveBeenCalled();
    expect(subject.getStatus().infrastructureError).toMatch(/authentication/i);
    await subject.stop();
  });

  it('polls rework backlogs as AFK implementation candidates', async () => {
    const rework = { ...item, state: 'rework' as const };
    const list = vi.fn(async (options: { state?: string }) => options.state === 'rework' ? [rework] : []);
    const run = vi.fn(async () => ({ success: false, skipped: 'not_claimed' as const }));
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async () => rework), list, claim: vi.fn(),
        transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}), removeTag: vi.fn(async () => {}), initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => true),
      },
      branches: {} as ProviderBundle['branches'], changes: {} as ProviderBundle['changes'],
    };
    const subject = new LoopRunner(providers, { workflowRunnerFactory: vi.fn(() => ({ run }) as any) });
    const internals = subject as any;
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.poll();
    await new Promise(resolve => setImmediate(resolve));

    expect(list).toHaveBeenCalledWith({ state: 'ready', executionMode: 'afk' });
    expect(list).toHaveBeenCalledWith({ state: 'rework', executionMode: 'afk' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ backlogId: '42' }));
  });

  it('limits polling to an explicit backlog execution scope', async () => {
    const ready = { ...item, state: 'ready' as const };
    const other = { ...ready, id: '43', branchName: 'afk/backlog-43' };
    const run = vi.fn(async () => ({ success: false, skipped: 'not_claimed' as const }));
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async (id: string) => id === '42' ? ready : other),
        list: vi.fn(async (options: { state?: string }) => options.state === 'ready' ? [ready, other] : []),
        claim: vi.fn(), transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}), removeTag: vi.fn(async () => {}), initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => true),
      },
      branches: {} as ProviderBundle['branches'], changes: {} as ProviderBundle['changes'],
    };
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'],
      workflowRunnerFactory: vi.fn(() => ({ run }) as any),
    });
    const internals = subject as any;
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.poll();
    await new Promise(resolve => setImmediate(resolve));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ backlogId: '42' }));
  });

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
