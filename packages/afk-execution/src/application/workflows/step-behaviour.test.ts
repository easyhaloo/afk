import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '../workflow-engine.js';
import type { ProviderBundle } from '@afk/infrastructure';
import type { BacklogItem } from '@afk/application';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { RunObserver } from '../../observability/run-observer.js';
import { compileTemplate, planSteps, selectAcVerificationStep, selectImplementationStep } from '../../domain/templates/compiler.js';
import { findFailedAcVerification } from './ac-self-correction.js';
import type { WorkflowTemplate } from '../../domain/templates/types.js';

vi.mock('../modules/project-resolver.js', () => ({ default: () => ({ name: 'project-resolver' }) }));

const observer = { record: vi.fn(async () => undefined) } as unknown as RunObserver;

const item: BacklogItem = {
  id: '42', title: 'Item', dependsOn: [], state: 'in_progress', executionMode: 'afk',
  tags: [], branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42',
};

/**
 * A template whose steps are named nothing like the historical ones. Every
 * behaviour the runner used to select by name has to follow the step's
 * declaration instead.
 */
const renamedTemplate: WorkflowTemplate = {
  name: 'renamed',
  version: 1,
  steps: [
    { id: 'build', role: 'implementer', phase: 'implementation', completionKind: 'task', prompt: '/goal build' },
    { id: 'check', role: 'verifier', phase: 'verification', completionKind: 'ac', prompt: '/goal check', dependsOn: ['build'] },
  ],
};

function runner(): WorkflowRunner {
  const agent = { name: 'claude-code', capabilities: new Set(), createExecution: async () => { throw new Error('not used'); } } as unknown as AgentProvider;
  const bundle = { backlog: { claim: vi.fn(async () => null) } } as unknown as ProviderBundle;
  return new WorkflowRunner(bundle, { agentProvider: agent, observer });
}

function stepCtx(): Record<string, unknown> {
  return {
    iid: 42, session: 'afk-42', baseSession: 'afk-42', primaryWtPath: process.cwd(),
    primaryBranch: 'afk/backlog-42', baseBranch: 'main', hardTimeoutMs: 1_000,
    completionTimeoutMs: 1_000, contextHighTokens: 1_000, budget: {}, executionMode: 'batch', stepIndex: 0,
  };
}

describe('a template that names its steps freely', () => {
  it('speaks the AC protocol on its verification step', async () => {
    const plan = compileTemplate(renamedTemplate);
    const check = selectAcVerificationStep(planSteps(plan))!;
    const subject = runner() as any;
    subject.observationContext = { traceId: 'run-42', runId: 'run-42', workItemId: '42', profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'test' } };
    vi.spyOn(subject.runtimeLifecycle, 'heartbeat').mockResolvedValue(undefined);
    subject.sandbox = { id: 'primary' };
    subject.resourceScope = { registerSandbox: vi.fn() };
    subject.runPhase = vi.fn(async () => ({
      completed: true,
      output: { type: 'goal_complete', kind: 'ac_verification', result: 'PASS', summary: 'verified' },
    }));

    const result = await subject.runStep(check, stepCtx(), {});

    expect(subject.runPhase).toHaveBeenCalledWith(expect.objectContaining({ completionKind: 'ac' }));
    expect(result.status).toBe('completed');
  });

  it('records its verification step under the phase the step declares', async () => {
    const plan = compileTemplate(renamedTemplate);
    const check = selectAcVerificationStep(planSteps(plan))!;
    const subject = runner() as any;
    subject.observationContext = { traceId: 'run-42', runId: 'run-42', workItemId: '42', profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'test' } };
    vi.spyOn(subject.runtimeLifecycle, 'heartbeat').mockResolvedValue(undefined);
    subject.sandbox = { id: 'primary' };
    subject.resourceScope = { registerSandbox: vi.fn() };
    subject.runPhase = vi.fn(async () => ({ completed: true, output: {} }));

    await subject.runStep(check, stepCtx(), {});

    expect(observer.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'step.started', stepId: 'check', phase: 'verification',
    }));
  });

  it('injects the AC feedback into its implementation step', async () => {
    const plan = compileTemplate(renamedTemplate);
    const build = selectImplementationStep(planSteps(plan))!;
    const subject = runner() as any;
    subject.acFeedback = {
      type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: 'shortcut is missing',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/s is ignored' }],
    };

    const prompt = await subject.resolveStepPrompt(build, { iid: 42 });

    expect(prompt).toContain('AC correction required');
    expect(prompt).toContain('/s enters search');
  });

  it('finds its failed acceptance step, which is what starts the self-correction loop', () => {
    const plan = compileTemplate(renamedTemplate);
    const failed = findFailedAcVerification(plan, {
      build: { stepId: 'build', status: 'completed', startedAt: '', completedAt: '' },
      check: { stepId: 'check', status: 'failed', startedAt: '', completedAt: '' },
    });

    expect(failed?.step.id).toBe('check');
    expect(failed?.result.status).toBe('failed');
  });

  it('re-runs its implementation step and then its acceptance step', async () => {
    const plan = compileTemplate(renamedTemplate);
    const subject = runner() as any;
    subject.config = { ...subject.config, maxSelfIterations: 2 };
    vi.spyOn(subject.runtimeLifecycle, 'heartbeat').mockResolvedValue(undefined);
    subject.runStep = vi.fn()
      .mockResolvedValueOnce({ stepId: 'build', status: 'completed', startedAt: '', completedAt: '' })
      .mockResolvedValueOnce({ stepId: 'check', status: 'completed', startedAt: '', completedAt: '' });
    const initial = {
      stepId: 'check', status: 'failed',
      output: {
        type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: 'shortcut is missing',
        failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/s is ignored' }],
      },
      startedAt: '', completedAt: '',
    };
    const results: Record<string, unknown> = { check: initial };

    await expect(subject.retryFailedAcVerification(plan, stepCtx(), initial, results)).resolves.toBe(true);

    expect(subject.runStep).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'build' }), expect.objectContaining({ stepIndex: 1 }), results);
    expect(subject.runStep).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'check' }), expect.objectContaining({ stepIndex: 1 }), results);
    expect(results['check']).toMatchObject({ status: 'completed' });
  });
});
