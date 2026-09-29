import { describe, expect, it, vi } from 'vitest';
import { LoopRunner } from './loop-runner';
import type { ProviderBundle } from '../providers';
import type { BacklogItem } from '../../domain/backlog/index';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  it('routes an explicitly scoped managed item through executeWorkItem without legacy implementation or QA', async () => {
    const ready = { ...item, state: 'ready' as const, workItemId: 'github:org/repo#42' as BacklogItem['workItemId'] };
    const providers = {
      backlog: { get: vi.fn(async () => ready), list: vi.fn(async () => [ready]), isRunnable: vi.fn(async () => true) },
      branches: {}, changes: {},
    } as unknown as ProviderBundle;
    const executeManagedWorkItem = vi.fn(async () => ({ status: 'merge_ready', changeUrl: 'https://example.test/pr/42' } as any));
    const workflowRunnerFactory = vi.fn();
    const qaRunnerFactory = vi.fn();
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'], managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/.afk/execution-manifest.json' },
      readManifest: vi.fn(async () => ({ workItemId: 'github:org/repo#42', providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'org/repo' } } as any)),
      executeManagedWorkItem, workflowRunnerFactory, qaRunnerFactory,
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.poll();
    await vi.waitFor(() => expect(executeManagedWorkItem).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(subject.getStatus().totals.completed).toBe(1));

    expect(executeManagedWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'github:org/repo#42', manifestPath: '/workspace/.afk/execution-manifest.json',
    }));
    expect(workflowRunnerFactory).not.toHaveBeenCalled();
    expect(qaRunnerFactory).not.toHaveBeenCalled();
    expect(subject.getStatus().qa.queue).toEqual([]);
    expect(internals.inFlight.has('42')).toBe(false);
  });

  it('stops a bounded managed loop only after the shared use case reports QA PASS and publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'afk-managed-loop-'));
    const ready = { ...item, state: 'ready' as const };
    const providers = {
      backlog: { get: vi.fn(async () => ready), list: vi.fn(async () => [ready]), isRunnable: vi.fn(async () => true) },
      branches: {}, changes: {},
    } as unknown as ProviderBundle;
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'], maxIterations: 1, pollIntervalMs: 60_000, statusIntervalMs: 60_000,
      pidFilePath: join(directory, 'loop.pid'), statusFilePath: join(directory, 'status.json'),
      managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json' },
      readManifest: vi.fn(async () => ({ workItemId: 'github:org/repo#42', providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'org/repo' } } as any)),
      executeManagedWorkItem: vi.fn(async () => ({ status: 'merge_ready', changeUrl: 'https://example.test/pr/42' } as any)),
    });
    try {
      await subject.start();
      expect(subject.getStatus().totals).toMatchObject({ completed: 1, failed: 0, started: 1 });
      expect(subject.getStatus().implement.active).toBe(0);
      expect(subject.getStatus().qa.queue).toEqual([]);
    } finally {
      await subject.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects mismatched managed manifest before polling, claiming, or creating the loop pid', async () => {
    const providers = { backlog: { list: vi.fn(), claim: vi.fn() }, branches: {}, changes: {} } as unknown as ProviderBundle;
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'], managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json' },
      readManifest: vi.fn(async () => ({ workItemId: 'github:org/repo#42', providerBacklogId: '43', tracker: { platform: 'github', projectKey: 'org/repo' } } as any)),
      executeManagedWorkItem: vi.fn(),
    });
    await expect(subject.start()).rejects.toThrow(/manifest.*42|backlog.*43/i);
    expect(providers.backlog.list).not.toHaveBeenCalled();
    expect(providers.backlog.claim).not.toHaveBeenCalled();
  });

  it('does not fall back to legacy after a managed execution failure', async () => {
    const ready = { ...item, state: 'ready' as const };
    const providers = { backlog: { get: vi.fn(async () => ready) }, branches: {}, changes: {} } as unknown as ProviderBundle;
    const workflowRunnerFactory = vi.fn();
    const qaRunnerFactory = vi.fn();
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'], managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json' },
      readManifest: vi.fn(async () => ({ workItemId: 'github:org/repo#42', providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'org/repo' } } as any)),
      executeManagedWorkItem: vi.fn(async () => { throw new Error('audit unavailable'); }),
      workflowRunnerFactory, qaRunnerFactory,
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    internals.inFlight.add('42');

    await internals.runChain('42');

    expect(workflowRunnerFactory).not.toHaveBeenCalled();
    expect(qaRunnerFactory).not.toHaveBeenCalled();
    expect(subject.getStatus().totals.failed).toBe(1);
    expect(subject.getStatus().lastError['42']).toContain('audit unavailable');
    expect(internals.inFlight.has('42')).toBe(false);
  });

  it.each([
    ['rework', 0, 0],
    ['blocked', 0, 1],
    ['not_claimed', 0, 0],
  ] as const)('does not count managed %s as completed or enqueue legacy QA', async (status, completed, failed) => {
    const ready = { ...item, state: 'ready' as const };
    const providers = { backlog: { get: vi.fn(async () => ready) }, branches: {}, changes: {} } as unknown as ProviderBundle;
    const workflowRunnerFactory = vi.fn();
    const qaRunnerFactory = vi.fn();
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'], managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json' },
      readManifest: vi.fn(async () => ({ workItemId: 'github:org/repo#42', providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'org/repo' } } as any)),
      executeManagedWorkItem: vi.fn(async () => ({ status } as any)),
      workflowRunnerFactory, qaRunnerFactory,
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    await internals.runChain('42');
    expect(subject.getStatus().totals).toMatchObject({ completed, failed });
    expect(subject.getStatus().qa.queue).toEqual([]);
    expect(workflowRunnerFactory).not.toHaveBeenCalled();
    expect(qaRunnerFactory).not.toHaveBeenCalled();
  });

  it('labels the manifest-less path as legacy, even when a canonical ID is present', async () => {
    const ready = { ...item, state: 'ready' as const, workItemId: 'github:org/repo#42' as BacklogItem['workItemId'] };
    const providers = { backlog: { get: vi.fn(async () => ready) }, branches: {}, changes: {} } as unknown as ProviderBundle;
    const run = vi.fn(async () => ({ success: false, skipped: 'not_claimed' as const }));
    const subject = new LoopRunner(providers, { workflowRunnerFactory: vi.fn(() => ({ run }) as any) });
    const internals = subject as any;
    internals.running = true;
    internals.emitEvent = vi.fn();
    await internals.runChain('42');
    expect(run).toHaveBeenCalledOnce();
    expect(internals.emitEvent).toHaveBeenCalledWith(expect.stringContaining('legacy'));
  });

  it('refuses a managed candidate from another provider project even with the same issue number', async () => {
    const wrongProject = { ...item, state: 'ready' as const, providerRef: 'github:other/repo#42' };
    const providers = { backlog: { get: vi.fn(async () => wrongProject) }, branches: {}, changes: {} } as unknown as ProviderBundle;
    const executeManagedWorkItem = vi.fn();
    const workflowRunnerFactory = vi.fn();
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'], managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json' },
      readManifest: vi.fn(async () => ({ workItemId: 'github:org/repo#42', providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'org/repo' } } as any)),
      executeManagedWorkItem, workflowRunnerFactory,
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.runChain('42');

    expect(executeManagedWorkItem).not.toHaveBeenCalled();
    expect(workflowRunnerFactory).not.toHaveBeenCalled();
    expect(subject.getStatus().lastError['42']).toMatch(/identity|project/);
  });

  it('rejects a manifest for a different tracker project before starting', async () => {
    const providers = { backlog: { list: vi.fn() }, branches: {}, changes: {} } as unknown as ProviderBundle;
    const subject = new LoopRunner(providers, {
      backlogIds: ['42'], managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json' },
      readManifest: vi.fn(async () => ({ workItemId: 'github:org/repo#42', providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'other/repo' } } as any)),
    });
    await expect(subject.start()).rejects.toThrow(/tracker|project|identity/);
    expect(providers.backlog.list).not.toHaveBeenCalled();
  });

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

  it('passes the configured template to each scoped workflow run', async () => {
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
      backlogIds: ['42', '43'],
      template: 'custom-workflow',
      workflowRunnerFactory: vi.fn(() => ({ run }) as any),
    });
    const internals = subject as any;
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.poll();
    await new Promise(resolve => setImmediate(resolve));

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({ backlogId: '42', template: 'custom-workflow' }));
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({ backlogId: '43', template: 'custom-workflow' }));
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

  it('uses the target branch for organizational parents and an explicit unmerged execution base for stacked work', async () => {
    const root = { ...item, id: '10', branchName: 'afk/backlog-10', parentId: undefined };
    const executionBase = { ...item, id: '11', branchName: 'afk/backlog-11', state: 'verification' as const };
    const completedBase = { ...item, id: '12', branchName: 'afk/backlog-12', state: 'done' as const };
    const organizationalChild = { ...item, id: '42', parentId: '10' };
    const stackedChild = { ...item, id: '43', parentId: '10', baseBacklogId: '11', branchName: 'afk/backlog-43' };
    const mergedBaseChild = { ...item, id: '44', baseBacklogId: '12', branchName: 'afk/backlog-44' };
    const items = new Map([['10', root], ['11', executionBase], ['12', completedBase], ['42', organizationalChild], ['43', stackedChild], ['44', mergedBaseChild]]);
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async (id: string) => items.get(id)!),
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
    expect(runs[0]).toMatchObject({ targetBranch: 'main', baseBranch: 'main' });

    await internals.runChain('43');
    expect(runs[1]).toMatchObject({ targetBranch: 'afk/backlog-11', baseBranch: 'afk/backlog-11' });

    await internals.runChain('44');
    expect(runs[2]).toMatchObject({ targetBranch: 'main', baseBranch: 'main' });

    await internals.runChain('10');
    expect(runs[3]).toMatchObject({ targetBranch: 'main', baseBranch: 'main' });
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
