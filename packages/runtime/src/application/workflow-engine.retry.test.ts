import { describe, expect, it, vi } from 'vitest';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import { WorkflowRunner } from './workflow-engine.js';
import type { RunObserver } from '../observability/run-observer.js';
import { BudgetManager } from './workflows/budget.js';
import type { ExecutionResult } from '../infrastructure/sandbox/types.js';

const worktreePath = '/tmp/afk-retry-worktree';

function executionResult(status: ExecutionResult['status'], code?: string): ExecutionResult {
  return {
    version: 1,
    runId: 'exec-1',
    status,
    provider: 'local',
    commits: [],
    ...(code ? { error: { code, message: `${code}: the upstream stream was cut` } } : {}),
  } as ExecutionResult;
}

function harness(results: ExecutionResult[], maxRetries = 2) {
  const createExecution = vi.fn(async () => {
    const index = createExecution.mock.calls.length - 1;
    const result = results[Math.min(index, results.length - 1)];
    return {
      id: `exec-${index + 1}`,
      metadata: { provider: 'codex', transport: 'process' },
      waitForResult: vi.fn(async () => result),
      waitForEvent: vi.fn(async () => null),
      captureOutput: vi.fn(async () => ''),
      captureSession: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      resume: vi.fn(async () => { throw new Error('resume is not supported'); }),
    };
  });

  const workflow = new WorkflowRunner(
    { backlog: { claim: vi.fn(async () => null), get: vi.fn(async () => ({ id: '42', state: 'ready' })) } } as unknown as ProviderBundle,
    {
      observer: { record: vi.fn(async () => undefined) } as unknown as RunObserver,
      agentProvider: { name: 'codex', capabilities: new Set(), createExecution } as never,
      sandboxProvider: { name: 'local', capabilities: new Set() } as never,
      config: { maxRetries, maxSelfIterations: 2 } as never,
    },
  );

  const phase = (workflow as unknown as { runPhase: (p: unknown) => Promise<{ completed: boolean }> }).runPhase({
    iid: 42,
    session: 'session-42',
    wtPath: worktreePath,
    hardTimeoutMs: 60_000,
    completionTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    contextHighTokens: Infinity,
    budget: new BudgetManager(4, 1_000_000),
    persistBudget: async () => undefined,
    prompt: 'implement the backlog item',
    signalType: 'goal_complete',
    executionMode: 'batch',
    completionKind: 'task',
  });

  return { phase, createExecution };
}

describe('WorkflowRunner agent failure retry', () => {
  it('repeats the step when the agent died rather than failed the work', async () => {
    const { phase, createExecution } = harness([
      executionResult('failed', 'AGENT_TURN_FAILED'),
      executionResult('completed'),
    ]);

    const outcome = await phase;

    expect(outcome.completed).toBe(true);
    expect(createExecution).toHaveBeenCalledTimes(2);
  });

  it('sends the same goal again, not a handoff prompt', async () => {
    const { phase, createExecution } = harness([
      executionResult('failed', 'AGENT_GONE'),
      executionResult('completed'),
    ]);

    await phase;

    const firstPrompt = createExecution.mock.calls[0][0].prompt;
    const secondPrompt = createExecution.mock.calls[1][0].prompt;
    expect(secondPrompt).toBe(firstPrompt);
  });

  it('gives up when the agent keeps dying, and the run fails', async () => {
    const { phase, createExecution } = harness([executionResult('failed', 'AGENT_TURN_FAILED')], 2);

    await expect(phase).rejects.toThrow(/AGENT_TURN_FAILED/);
    expect(createExecution).toHaveBeenCalledTimes(3);
  });

  it('does not repeat a step that failed for a reason about the work', async () => {
    const { phase, createExecution } = harness([executionResult('failed', 'SIGNAL_MISMATCH')]);

    await expect(phase).rejects.toThrow(/SIGNAL_MISMATCH/);
    expect(createExecution).toHaveBeenCalledTimes(1);
  });
});
