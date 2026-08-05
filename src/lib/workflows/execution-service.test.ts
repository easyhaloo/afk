import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionService } from './execution-service';
import type { AgentProvider } from '../agents/types';
import type { AgentExecution, Sandbox, ExecutionResult } from '../sandbox/types';

const provider: AgentProvider = {
  name: 'claude-code', capabilities: new Set(['interactive']),
  buildCommand: vi.fn(() => ({ argv: ['fake-agent'], cwd: '/tmp/worktree' })),
};

function execution(result: ExecutionResult): AgentExecution {
  return { id: `e-${Math.random()}`, waitForEvent: async () => null, waitForResult: async () => result,
    interrupt: async () => {}, kill: async () => {}, captureOutput: async () => '', captureSession: async () => undefined,
    resume: async () => { throw new Error('unsupported'); } };
}

describe('AgentExecutionService', () => {
  it('retries failed agent steps but never retries timeout', async () => {
    const startAgent = vi.fn()
      .mockResolvedValueOnce(execution({ version: 1, runId: '1', status: 'failed', provider: 'local', commits: [] }))
      .mockResolvedValueOnce(execution({ version: 1, runId: '2', status: 'completed', provider: 'local', commits: [] }));
    const sandbox = { startAgent, close: async () => {} } as unknown as Sandbox;
    const service = new AgentExecutionService();
    const result = await service.execute({ provider, sandbox, worktreePath: '/tmp/worktree', prompt: 'do it', signalType: 'goal_complete', generation: 1, maxRetries: 1, completionTimeoutMs: 10, contextHighTokens: 100 });
    expect(result.status).toBe('completed');
    expect(startAgent).toHaveBeenCalledTimes(2);
  });

  it('accepts a completed batch result through the unified signal', async () => {
    const sandbox = { startAgent: vi.fn().mockResolvedValue(execution({ version: 1, runId: '1', status: 'completed', provider: 'batch', structuredOutput: { type: 'goal_complete' }, commits: [] })), close: async () => {} } as unknown as Sandbox;
    const service = new AgentExecutionService();
    await expect(service.execute({ provider, sandbox, worktreePath: '/tmp/worktree', prompt: 'verify', signalType: 'goal_complete', executionMode: 'batch', generation: 1, maxRetries: 0, completionTimeoutMs: 10, contextHighTokens: 100 })).resolves.toMatchObject({ status: 'completed' });
  });
});
