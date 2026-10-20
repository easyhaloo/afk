import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from './workflow-engine.js';
import { BudgetManager } from './workflows/budget.js';
import type { AgentProvider, ExecutionResult } from '../domain/agents/types.js';
import type { ProviderBundle } from '@afk/infrastructure';
import type { RunObserver } from '../observability/run-observer.js';

/**
 * A completion that carries no payload, or the wrong signal, is not a
 * completion. Every transport checks the signal before reporting one; the
 * runner checks it again, because a transport that forgot is exactly the
 * case worth catching.
 */
describe('WorkflowRunner completion validation', () => {
  function runnerReturning(result: ExecutionResult) {
    const transition = vi.fn(async () => {});
    const setExecutionMode = vi.fn(async () => {});
    const runner = new WorkflowRunner(
      { backlog: { transition, setExecutionMode } } as unknown as ProviderBundle,
      {
        observer: { record: vi.fn() } as unknown as RunObserver,
        agentProvider: {
          name: 'claude-code',
          capabilities: new Set(),
          createExecution: async () => ({
            id: 'execution-1',
            sessionId: 'run-42',
            metadata: { provider: 'claude-code' as const, transport: 'exec' as const },
            waitForEvent: async () => null,
            waitForResult: async () => result,
            interrupt: async () => {},
            kill: async () => {},
            captureOutput: async () => '',
            captureSession: async () => undefined,
          }),
        } as unknown as AgentProvider,
      },
    );
    (runner as any).activeBacklog = { id: '42' };
    (runner as any).observationContext = {
      traceId: 'trace-1', runId: 'run-42', workItemId: 'work-1',
      profileId: 'default', attempt: 1, actor: { kind: 'system', id: 'runner' },
    };
    return { runner, transition, setExecutionMode };
  }

  function phase(budget: BudgetManager) {
    return {
      iid: 42,
      session: 'run-42',
      wtPath: '/tmp/worktree',
      hardTimeoutMs: 1000,
      completionTimeoutMs: 1000,
      contextHighTokens: 100,
      budget,
      persistBudget: vi.fn(),
      prompt: 'work',
      signalType: 'goal_complete' as const,
      executionMode: 'batch' as const,
      completionKind: 'task' as const,
      sandbox: {},
    };
  }

  it('accepts a completion that carries the expected signal', async () => {
    const { runner } = runnerReturning({
      version: 1, runId: 'run-42', status: 'completed', provider: 'claude-code',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'done' },
      commits: [],
    });
    await expect((runner as any).runPhase(phase(BudgetManager.forTest(0, 0, 3, 1000))))
      .resolves.toEqual({ completed: true, output: { type: 'goal_complete', kind: 'task', summary: 'done' } });
  });

  it('refuses a completion that carries no payload', async () => {
    const { runner, transition } = runnerReturning({
      version: 1, runId: 'run-42', status: 'completed', provider: 'claude-code',
      structuredOutput: undefined,
      commits: [],
    });
    await expect((runner as any).runPhase(phase(BudgetManager.forTest(0, 0, 3, 1000))))
      .rejects.toThrow(/expected goal_complete structured result/);
    expect(transition).not.toHaveBeenCalled();
  });

  it('refuses a completion that names another signal', async () => {
    const { runner } = runnerReturning({
      version: 1, runId: 'run-42', status: 'completed', provider: 'claude-code',
      structuredOutput: { type: 'other' },
      commits: [],
    });
    await expect((runner as any).runPhase(phase(BudgetManager.forTest(0, 0, 3, 1000))))
      .rejects.toThrow(/expected goal_complete structured result/);
  });
});
