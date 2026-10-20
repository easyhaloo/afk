import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '../workflow-engine.js';
import { HandoffCoordinator } from './handoff.js';
import { BudgetManager } from './budget.js';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { ProviderBundle } from '@afk/infrastructure';
import type { RunObserver } from '../../observability/run-observer.js';

/**
 * A handoff that leaves no trace is a handoff nobody can explain. These
 * tests pin the two properties the handoff path owes its caller: the
 * coordinator is the real one, and the handoff reaches the audit spine.
 */
describe('Handoff wiring', () => {
  function fakeExecution(status: 'context_high' | 'completed') {
    return {
      id: 'execution-1',
      sessionId: 'run-42',
      metadata: { provider: 'claude-code' as const, transport: 'exec' as const },
      waitForEvent: async () => null,
      waitForResult: async () => ({
        status,
        summary: '',
        structuredOutput: undefined,
        commits: [],
      }),
      interrupt: async () => {},
      kill: async () => {},
      captureOutput: async () => '',
      captureSession: async () => undefined,
    };
  }

  function runnerWith(options: {
    record: ReturnType<typeof vi.fn>;
    handoff?: ReturnType<typeof vi.fn>;
    coordinatorFactory?: (deps: unknown) => HandoffCoordinator;
  }) {
    const transition = vi.fn(async () => {});
    const setExecutionMode = vi.fn(async () => {});
    const runner = new WorkflowRunner(
      { backlog: { transition, setExecutionMode } } as unknown as ProviderBundle,
      {
        observer: { record: options.record } as unknown as RunObserver,
        agentProvider: {
          name: 'claude-code',
          capabilities: new Set(),
          createExecution: async () => fakeExecution('context_high'),
        } as unknown as AgentProvider,
        ...(options.coordinatorFactory ? { coordinatorFactory: options.coordinatorFactory as never } : {}),
      },
    );
    (runner as any).activeBacklog = { id: '42' };
    // runBody sets this before the phase loop; the test drives the loop
    // directly, so it sets it too.
    (runner as any).observationContext = {
      traceId: 'trace-1', runId: 'run-42', workItemId: 'work-1',
      profileId: 'default', attempt: 1, actor: { kind: 'system', id: 'runner' },
    };
    return { runner, transition, setExecutionMode };
  }

  it('wires a real coordinator instead of a stub', () => {
    const { runner } = runnerWith({ record: vi.fn() });
    expect((runner as any).coordinator).toBeInstanceOf(HandoffCoordinator);
  });

  it('records the handoff in the audit spine', async () => {
    const record = vi.fn();
    const handoff = vi.fn(async () => 'terminated' as const);
    const { runner } = runnerWith({ record, coordinatorFactory: () => ({ handoff }) as never });

    const result = await (runner as any).runPhase({
      iid: 42,
      session: 'run-42',
      wtPath: '/tmp/worktree',
      hardTimeoutMs: 1000,
      completionTimeoutMs: 1000,
      contextHighTokens: 100,
      budget: BudgetManager.forTest(0, 100, 1, 1000),
      persistBudget: vi.fn(),
      prompt: 'work',
      signalType: 'goal_complete',
      executionMode: 'batch',
      completionKind: 'task',
      sandbox: {},
    });

    expect(handoff).toHaveBeenCalled();
    expect(result).toEqual({ completed: false });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'handoff.performed', mode: 'auto', outcome: 'terminated' }),
    );
  });
});
