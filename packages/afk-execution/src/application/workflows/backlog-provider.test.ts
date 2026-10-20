import { describe, expect, it, vi, type Mock } from 'vitest';
import { WorkflowRunner } from '../workflow-engine.js';
import { BudgetManager } from './budget.js';
import type { ProviderBundle } from '@afk/infrastructure';
import type { BacklogClaim, BacklogItem, BacklogProvider } from '@afk/application';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { RunObserver } from '../../observability/run-observer.js';
import { TemplateCatalog } from '../../domain/templates/catalog.js';
import { compileTemplate } from '../../domain/templates/compiler.js';
import { PluginRuntime } from '../plugins/runtime.js';

const observer = { record: vi.fn(async () => undefined) } as unknown as RunObserver;

vi.mock('../modules/project-resolver.js', () => ({ default: () => ({ name: 'project-resolver' }) }));

const item: BacklogItem = {
  id: '42', title: 'Item', dependsOn: [], state: 'in_progress', executionMode: 'afk',
  tags: [], branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42',
};

function providers(claim: BacklogProvider['claim']): ProviderBundle {
  return {
    backlog: {
      claim, transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}),
      get: vi.fn(async () => item), list: vi.fn(async () => []), isRunnable: vi.fn(async () => true),
      getActiveRework: vi.fn(async () => undefined),
    },
    branches: { createBranch: vi.fn(), push: vi.fn(), commit: vi.fn(), cleanup: vi.fn() },
    changes: { create: vi.fn(), get: vi.fn(), findForBacklog: vi.fn(), merge: vi.fn(), close: vi.fn() },
  } as unknown as ProviderBundle;
}

function claimed(itemToClaim = item): { claim: BacklogClaim; release: Mock<[], Promise<void>> } {
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
  const agent = { name: 'claude-code', capabilities: new Set(), createExecution: async () => { throw new Error('not used'); } } as unknown as AgentProvider;
  return new WorkflowRunner(bundle, { agentProvider: agent, observer });
}

describe('WorkflowRunner backlog provider mode', () => {
  it('runs a phase through a provider that exposes only createExecution', async () => {
    const bundle = providers(vi.fn(async () => null));
    const runtime = {
      kind: 'codex', transport: 'exec', auth: 'chatgpt', provider: 'openai', startupTimeoutMs: 5_000,
    } as const;
    const execution = {
      id: 'execution-42',
      metadata: { provider: 'codex', transport: 'exec' },
      waitForResult: vi.fn(async () => ({
        version: 1, runId: 'execution-42', status: 'completed', provider: 'batch',
        structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'done' }, commits: [],
      })),
      waitForEvent: vi.fn(async () => null), interrupt: vi.fn(), kill: vi.fn(),
      captureOutput: vi.fn(async () => ''), captureSession: vi.fn(async () => undefined), resume: vi.fn(),
    };
    const createExecution = vi.fn(async () => execution);
    const agent = { name: 'codex', capabilities: new Set(), createExecution } as unknown as AgentProvider;
    const sandbox = { id: 'sandbox-42' };
    const subject = new WorkflowRunner(bundle, { agentProvider: agent, agentRuntime: runtime, observer }) as any;
    vi.spyOn(subject.runtimeLifecycle, 'heartbeat').mockResolvedValue(undefined);
    vi.spyOn(subject.runtimeLifecycle, 'diagnostics').mockResolvedValue(undefined);

    await expect(subject.runPhase({
      iid: 42,
      session: 'session-42',
      wtPath: '/tmp/worktree-42',
      hardTimeoutMs: 1_000,
      completionTimeoutMs: 2_000,
      contextHighTokens: 3_000,
      budget: new BudgetManager(3, 10000),
      persistBudget: vi.fn(async () => {}),
      prompt: 'implement backlog 42',
      signalType: 'goal_complete',
      executionMode: 'batch',
      agentProvider: agent,
      runtime,
      sandbox,
      completionKind: 'task',
    })).resolves.toMatchObject({ completed: true });

    expect(createExecution).toHaveBeenCalledWith({
      sandbox,
      worktreePath: '/tmp/worktree-42',
      sessionId: 'session-42',
      prompt: expect.stringContaining('implement backlog 42'),
      signalType: 'goal_complete',
      generation: 1,
      executionMode: 'batch',
      runtime,
    });
    expect(subject.runtimeLifecycle.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      agentTransport: 'exec',
    }));
  });

  it('does not create a change request before QA verification', async () => {
    const { claim } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const subject = runner(bundle) as any;
    subject.activeBacklog = item;
    subject.primaryHandle = { branch: item.branchName, path: process.cwd(), isNewBranch: true };
    subject.pushBranch = vi.fn(async () => {});
    subject.cleanupPrimary = vi.fn(async () => {});

    await expect(subject.autoWrapup(42, process.cwd(), 'worker-a', 'main')).resolves.toEqual({ success: true });
    expect(subject.pushBranch).toHaveBeenCalledWith(process.cwd());
    expect(bundle.changes.create).not.toHaveBeenCalled();
    expect(bundle.backlog.transition).toHaveBeenCalledWith('42', 'verification', undefined);
  });

  it('adds structured AC feedback only to a corrective implementation prompt', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    subject.acFeedback = {
      type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: 'search shortcut failed',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
    };

    // The phase selects the step that receives the correction — not its name.
    const implementation = await subject.resolveStepPrompt({ id: 'build', prompt: '/goal implement #{iid}', phase: 'implementation' }, { iid: 42 });
    const verifier = await subject.resolveStepPrompt({ id: 'check', prompt: '/goal verify #{iid}', phase: 'verification' }, { iid: 42 });

    expect(implementation).toContain('AC correction required');
    expect(implementation).toContain('/s enters search');
    expect(verifier).not.toContain('AC correction required');
  });

  it('injects the claimed backlog title and description into implementation prompts', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    subject.activeBacklog = {
      ...item,
      title: 'Add interactive JSON proof',
      description: 'Create e2e-interactive-json-proof.txt with the exact required content.',
    };

    const prompt = await subject.resolveStepPrompt({ id: 'build', prompt: '/goal implement issue #{iid}', phase: 'implementation' }, { iid: 42 });

    expect(prompt).toContain('Add interactive JSON proof');
    expect(prompt).toContain('Create e2e-interactive-json-proof.txt');
  });

  it('injects the active QA rework record into the next implementation prompt', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    subject.activeRework = {
      id: 'r2', attempt: 2, source: 'qa', status: 'open', createdAt: '2026-08-05T00:00:00.000Z',
      summary: 'integration QA found a shortcut regression',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/s is ignored' }],
      requiredChecks: [{ command: 'pnpm vitest run', expected: 'passes' }],
    };

    const prompt = await subject.resolveStepPrompt({ id: 'build', prompt: '/goal implement #{iid}', phase: 'implementation' }, { iid: 42 });

    expect(prompt).toContain('open QA rework record (r2, attempt 2)');
    expect(prompt).toContain('/s enters search');
    expect(prompt).toContain('pnpm vitest run');
  });

  it('closes an interactive phase sandbox before returning even when a resource scope owns it', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    const primarySandbox = { id: 'primary', startAgent: vi.fn(), close: vi.fn() };
    const phaseSandbox = { id: 'verify', startAgent: vi.fn(), close: vi.fn() };
    const create = vi.fn(async () => phaseSandbox);
    subject.activeBacklog = item;
    subject.observationContext = {
      traceId: 'run-42', runId: 'run-42', workItemId: item.id, profileId: 'test', attempt: 1,
      actor: { kind: 'system', id: 'test' },
    };
    subject.sandbox = primarySandbox;
    subject.resourceScope = { registerSandbox: vi.fn() };
    subject.sandboxProvider = { create };
    vi.spyOn(subject.runtimeLifecycle, 'heartbeat').mockResolvedValue(undefined);
    subject.runPhase = vi.fn(async () => ({
      completed: true,
      output: { type: 'goal_complete', kind: 'ac_verification', result: 'PASS', summary: 'verified' },
    }));

    await subject.runStep(
      { id: 'check', kind: 'agent', role: 'verifier', prompt: '/goal verify', phase: 'verification', completionKind: 'ac', completionSignal: 'goal_complete', legacy: false, branch: { type: 'issue', iid: 0 } },
      {
        iid: 42, session: 'afk-42-check', primaryWtPath: process.cwd(), primaryBranch: 'afk/backlog-42',
        baseBranch: 'main', hardTimeoutMs: 1_000, completionTimeoutMs: 1_000, contextHighTokens: 1_000,
        budget: {}, executionMode: 'interactive', stepIndex: 0,
      },
      {},
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: process.cwd(), session: 'afk-42-check', executionMode: 'interactive',
    }));
    expect(subject.runPhase).toHaveBeenCalledWith(expect.objectContaining({ sandbox: phaseSandbox, completionKind: 'ac' }));
    expect(phaseSandbox.close).toHaveBeenCalledTimes(1);
    expect(primarySandbox.close).not.toHaveBeenCalled();
  });

  it('retries a diagnosable AC failure in the same implementation branch', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    subject.config = { ...subject.config, maxSelfIterations: 2 };
    const initial = {
      stepId: 'check', status: 'failed', output: {
        type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: 'shortcut is missing',
        failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/s is ignored' }],
      }, startedAt: '', completedAt: '',
    };
    const results: Record<string, any> = { check: initial };
    subject.runStep = vi.fn()
      .mockResolvedValueOnce({ stepId: 'build', status: 'completed', startedAt: '', completedAt: '' })
      .mockResolvedValueOnce({ stepId: 'check', status: 'completed', startedAt: '', completedAt: '' });
    vi.spyOn(subject.runtimeLifecycle, 'heartbeat').mockResolvedValue(undefined);
    // The plan names its steps freely: the loop follows the declared phase
    // and completion kind, not a step id.
    const plan = compileTemplate({
      name: 'retry-plan', version: 1,
      steps: [
        { id: 'build', role: 'implementer', phase: 'implementation', completionKind: 'task', prompt: '/goal implement' },
        { id: 'check', role: 'verifier', phase: 'verification', completionKind: 'ac', prompt: '/goal verify', dependsOn: ['build'] },
      ],
    });

    await expect(subject.retryFailedAcVerification(plan, {
      iid: 42, session: 'worker', baseSession: 'worker', primaryWtPath: process.cwd(), primaryBranch: 'afk/backlog-42', baseBranch: 'main',
      hardTimeoutMs: 1_000, completionTimeoutMs: 1_000, contextHighTokens: 1_000, budget: {}, executionMode: 'batch',
    }, initial, results)).resolves.toBe(true);

    expect(subject.runStep).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'build' }), expect.objectContaining({ primaryBranch: 'afk/backlog-42', stepIndex: 1 }), results);
    expect(subject.runStep).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'check' }), expect.objectContaining({ primaryBranch: 'afk/backlog-42', stepIndex: 1 }), results);
    expect(results['check'].status).toBe('completed');
    expect(subject.acFeedback).toBeUndefined();
  });

  it('does not retry an AC failure without a complete diagnosis', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    const initial = { stepId: 'check', status: 'failed', output: { type: 'goal_complete', kind: 'ac_verification', result: 'FAIL' }, startedAt: '', completedAt: '' };
    subject.runStep = vi.fn();
    const plan = compileTemplate({
      name: 'retry-plan', version: 1,
      steps: [
        { id: 'build', role: 'implementer', phase: 'implementation', completionKind: 'task', prompt: '/goal implement' },
        { id: 'check', role: 'verifier', phase: 'verification', completionKind: 'ac', prompt: '/goal verify', dependsOn: ['build'] },
      ],
    });

    await expect(subject.retryFailedAcVerification(plan, {
      iid: 42, session: 'worker', baseSession: 'worker', primaryWtPath: process.cwd(), primaryBranch: 'afk/backlog-42', baseBranch: 'main',
      hardTimeoutMs: 1_000, completionTimeoutMs: 1_000, contextHighTokens: 1_000, budget: {}, executionMode: 'batch',
    }, initial, {})).resolves.toBe(false);
    expect(subject.runStep).not.toHaveBeenCalled();
  });

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

    await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' })).resolves.toEqual({ success: false, skipped: 'not_claimed' });
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

  it('publishes a runtime record independently of backlog state', async () => {
    const { claim } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const runtime = {
      start: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
    };
    const agent = { name: 'claude-code', capabilities: new Set(), createExecution: async () => { throw new Error('not used'); } } as unknown as AgentProvider;
    const subject = new WorkflowRunner(bundle, { agentProvider: agent, runtimeManager: runtime as any, observer }) as any;
    subject.runBody = vi.fn(async () => ({ success: false }));

    await subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main', executionMode: 'batch' });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backlogId: '42', workspace: process.cwd(), providerRef: 'github:org/repo#42',
      phase: 'implementing', executionMode: 'batch', status: 'running',
    }));
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'blocked' }));
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

  it('archives a claimed runtime when setup fails before a worktree exists', async () => {
    const { claim } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const runtime = { start: vi.fn(async () => {}), heartbeat: vi.fn(async () => ({})), finish: vi.fn(async () => ({})) };
    const agent = { name: 'claude-code', capabilities: new Set(), createExecution: async () => { throw new Error('not used'); } } as unknown as AgentProvider;
    const subject = new WorkflowRunner(bundle, { agentProvider: agent, runtimeManager: runtime as any, observer }) as any;
    subject.sandboxProviderByName = vi.fn(() => { throw new Error('sandbox setup failed'); });

    await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' })).rejects.toThrow('sandbox setup failed');
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ backlogId: '42', progress: 'claimed' }));
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'blocked', errorSummary: expect.stringContaining('workflow setup failed'),
    }));
  });

  it('runs the provider the template declares, not a hard-coded default', async () => {
    const { claim } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    // The catalogue the runner reads its template from. A template that only
    // this catalogue holds is the one the run executes: the seam is explicit.
    const catalog = new TemplateCatalog();
    catalog.register({
      name: 'provider-from-template', version: 1, defaultProvider: 'codex',
      steps: [{ id: 'implement', role: 'implementer', prompt: 'p' }],
    });
    // No injected agent provider: the runner has to resolve one itself.
    const subject = new WorkflowRunner(bundle, { observer, catalog }) as any;
    vi.spyOn(subject.runtimeLifecycle, 'heartbeat').mockResolvedValue(undefined);
    vi.spyOn(subject.runtimeLifecycle, 'diagnostics').mockResolvedValue(undefined);
    const load = vi.spyOn(catalog, 'load');
    await subject.run({
      iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main',
      template: 'provider-from-template',
    }).catch(() => undefined);

    // The graph projection reads the same field, so the drawing and the run
    // can no longer disagree about which agent is going to run.
    expect(subject.agentProviderName).toBe('codex');
    expect(subject.agentProvider.name).toBe('codex');
    // The template came from the catalogue the runner was given: a runner
    // that bypassed it would have found no template at all.
    expect(load).toHaveBeenCalledWith('provider-from-template', expect.objectContaining({ projectRoot: expect.any(String) }));
  });

  it('offers a template a plugin registered to the catalogue the runner reads from', async () => {
    const { claim } = claimed();
    const bundle = providers(vi.fn(async () => claim));
    const plugins = new PluginRuntime();
    await plugins.load({
      id: 'template-plugin', version: '1.0.0',
      setup: context => {
        context.template({
          name: 'from-plugin', version: 1,
          steps: [{ id: 'implement', role: 'implementer', prompt: 'p' }],
        });
      },
    });
    const subject = new WorkflowRunner(bundle, { observer, plugins }) as any;

    // The plugin's template exists in no other catalogue: a runner that built
    // its own would not know the name. The documented capability is delivered,
    // not merely declared.
    expect(subject.catalog.names()).toContain('from-plugin');
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
