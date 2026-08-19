import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionService } from './execution-service';
import type { AgentProvider } from '../../domain/agents/types';
import type { AgentExecution, Sandbox, ExecutionResult } from '../../infrastructure/sandbox/types';

const provider: AgentProvider = {
  name: 'claude-code', capabilities: new Set(['interactive']),
  createExecution: vi.fn(),
};

function execution(result: ExecutionResult): AgentExecution {
  return { id: `e-${Math.random()}`, metadata: { provider: 'claude-code', transport: 'process' }, waitForEvent: async () => null, waitForResult: async () => result,
    interrupt: async () => {}, kill: async () => {}, captureOutput: async () => '', captureSession: async () => undefined,
    resume: async () => { throw new Error('unsupported'); } };
}

describe('AgentExecutionService', () => {
  it('retries failed agent steps but never retries timeout', async () => {
    const createExecution = vi.mocked(provider.createExecution)
      .mockResolvedValueOnce(execution({ version: 1, runId: '1', status: 'failed', provider: 'local', commits: [] }))
      .mockResolvedValueOnce(execution({
        version: 1,
        runId: '2',
        status: 'completed',
        provider: 'local',
        structuredOutput: { type: 'goal_complete' },
        commits: [],
      }));
    const sandbox = { close: async () => {} } as unknown as Sandbox;
    const runtime = {
      kind: 'codex',
      transport: 'exec',
      auth: 'chatgpt',
      provider: 'openai',
      startupTimeoutMs: 5_000,
    } as const;
    const service = new AgentExecutionService();
    const result = await service.execute({ provider, sandbox, worktreePath: '/tmp/worktree', sessionId: 'session-1', prompt: 'do it', signalType: 'goal_complete', executionMode: 'batch', runtime, generation: 1, maxRetries: 1, completionTimeoutMs: 10, contextHighTokens: 100 });
    expect(result.status).toBe('completed');
    expect(createExecution).toHaveBeenCalledTimes(2);
    expect(createExecution).toHaveBeenNthCalledWith(1, {
      sandbox,
      worktreePath: '/tmp/worktree',
      sessionId: 'session-1',
      prompt: 'do it',
      signalType: 'goal_complete',
      generation: 1,
      interactive: false,
      executionMode: 'batch',
      runtime,
    });
    expect(createExecution).toHaveBeenNthCalledWith(2, expect.objectContaining({
      generation: 2,
      runtime,
    }));
  });

  it('accepts a completed batch result through the unified signal', async () => {
    vi.mocked(provider.createExecution).mockResolvedValueOnce(execution({ version: 1, runId: '1', status: 'completed', provider: 'batch', structuredOutput: { type: 'goal_complete' }, commits: [] }));
    const sandbox = { close: async () => {} } as unknown as Sandbox;
    const service = new AgentExecutionService();
    await expect(service.execute({ provider, sandbox, worktreePath: '/tmp/worktree', prompt: 'verify', signalType: 'goal_complete', executionMode: 'batch', generation: 1, maxRetries: 0, completionTimeoutMs: 10, contextHighTokens: 100 })).resolves.toMatchObject({ status: 'completed' });
  });
});
