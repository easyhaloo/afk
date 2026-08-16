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
      getActiveRework: vi.fn(async () => undefined),
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
  const agent = { name: 'claude-code', capabilities: new Set(), createExecution: async () => { throw new Error('not used'); } } as unknown as AgentProvider;
  return new WorkflowRunner(bundle, { agentProvider: agent });
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
    const subject = new WorkflowRunner(bundle, { agentProvider: agent, agentRuntime: runtime }) as any;
    subject.heartbeatRuntime = vi.fn(async () => {});
    subject.writeRuntimeDiagnostics = vi.fn(async () => {});

    await expect(subject.runPhase({
      iid: 42,
      session: 'session-42',
      wtPath: '/tmp/worktree-42',
      hardTimeoutMs: 1_000,
      completionTimeoutMs: 2_000,
      contextHighTokens: 3_000,
      budget: { used: 0 },
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
    expect(subject.heartbeatRuntime).toHaveBeenCalledWith(expect.objectContaining({
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

    const implementation = await subject.resolveStepPrompt({ id: 'implement', prompt: '/goal implement #{iid}' }, { iid: 42 });
    const verifier = await subject.resolveStepPrompt({ id: 'verify-ac', prompt: '/goal verify #{iid}' }, { iid: 42 });

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

    const prompt = await subject.resolveStepPrompt({ id: 'implement', prompt: '/goal implement issue #{iid}' }, { iid: 42 });

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

    const prompt = await subject.resolveStepPrompt({ id: 'implement', prompt: '/goal implement #{iid}' }, { iid: 42 });

    expect(prompt).toContain('open QA rework record (r2, attempt 2)');
    expect(prompt).toContain('/s enters search');
    expect(prompt).toContain('pnpm vitest run');
  });

  it('uses an independent sandbox session for an interactive primary-worktree phase', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    const primarySandbox = { id: 'primary', startAgent: vi.fn(), close: vi.fn() };
    const phaseSandbox = { id: 'verify', startAgent: vi.fn(), close: vi.fn() };
    const create = vi.fn(async () => phaseSandbox);
    subject.activeBacklog = item;
    subject.sandbox = primarySandbox;
    subject.sandboxProvider = { create };
    subject.heartbeatRuntime = vi.fn(async () => {});
    subject.runPhase = vi.fn(async () => ({
      completed: true,
      output: { type: 'goal_complete', kind: 'ac_verification', result: 'PASS', summary: 'verified' },
    }));

    await subject.runStep(
      { id: 'verify-ac', prompt: '/goal verify', branch: { type: 'issue', iid: 0 } },
      {
        iid: 42, session: 'afk-42-verify-ac', primaryWtPath: process.cwd(), primaryBranch: 'afk/backlog-42',
        baseBranch: 'main', hardTimeoutMs: 1_000, completionTimeoutMs: 1_000, contextHighTokens: 1_000,
        budget: {}, executionMode: 'interactive', stepIndex: 0,
      },
      {},
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: process.cwd(), session: 'afk-42-verify-ac', executionMode: 'interactive',
    }));
    expect(subject.runPhase).toHaveBeenCalledWith(expect.objectContaining({ sandbox: phaseSandbox, completionKind: 'ac' }));
    expect(phaseSandbox.close).toHaveBeenCalledTimes(1);
  });

  it('retries a diagnosable AC failure in the same implementation branch', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    subject.config = { ...subject.config, maxSelfIterations: 2 };
    const initial = {
      stepId: 'verify-ac', status: 'failed', output: {
        type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: 'shortcut is missing',
        failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/s is ignored' }],
      }, startedAt: '', completedAt: '',
    };
    const results: Record<string, any> = { 'verify-ac': initial };
    subject.runStep = vi.fn()
      .mockResolvedValueOnce({ stepId: 'implement', status: 'completed', startedAt: '', completedAt: '' })
      .mockResolvedValueOnce({ stepId: 'verify-ac', status: 'completed', startedAt: '', completedAt: '' });
    subject.heartbeatRuntime = vi.fn(async () => {});
    const template = {
      steps: [{ id: 'implement', prompt: '/goal implement' }, { id: 'verify-ac', prompt: '/goal verify' }],
    };

    await expect(subject.retryFailedAcVerification(template, {
      iid: 42, session: 'worker', baseSession: 'worker', primaryWtPath: process.cwd(), primaryBranch: 'afk/backlog-42', baseBranch: 'main',
      hardTimeoutMs: 1_000, completionTimeoutMs: 1_000, contextHighTokens: 1_000, budget: {}, executionMode: 'batch',
    }, initial, results)).resolves.toBe(true);

    expect(subject.runStep).toHaveBeenNthCalledWith(1, template.steps[0], expect.objectContaining({ primaryBranch: 'afk/backlog-42', stepIndex: 1 }), results);
    expect(subject.runStep).toHaveBeenNthCalledWith(2, template.steps[1], expect.objectContaining({ primaryBranch: 'afk/backlog-42', stepIndex: 1 }), results);
    expect(results['verify-ac'].status).toBe('completed');
    expect(subject.acFeedback).toBeUndefined();
  });

  it('does not retry an AC failure without a complete diagnosis', async () => {
    const bundle = providers(vi.fn(async () => null));
    const subject = runner(bundle) as any;
    const initial = { stepId: 'verify-ac', status: 'failed', output: { type: 'goal_complete', kind: 'ac_verification', result: 'FAIL' }, startedAt: '', completedAt: '' };
    subject.runStep = vi.fn();

    await expect(subject.retryFailedAcVerification({ steps: [{ id: 'implement' }, { id: 'verify-ac' }] }, {
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
    const subject = new WorkflowRunner(bundle, { agentProvider: agent, runtimeManager: runtime as any }) as any;
    subject.runBody = vi.fn(async () => ({ success: false }));

    await subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main', executionMode: 'batch' });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backlogId: '42', phase: 'implementing', executionMode: 'batch', status: 'running',
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
    const subject = new WorkflowRunner(bundle, { agentProvider: agent, runtimeManager: runtime as any }) as any;
    subject.sandboxProviderByName = vi.fn(() => { throw new Error('sandbox setup failed'); });

    await expect(subject.run({ iid: 42, backlogId: '42', session: 'worker-a', targetBranch: 'main', baseBranch: 'main' })).rejects.toThrow('sandbox setup failed');
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ backlogId: '42', progress: 'claimed' }));
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'blocked', errorSummary: expect.stringContaining('workflow setup failed'),
    }));
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
