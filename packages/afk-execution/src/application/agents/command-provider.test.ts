import { describe, expect, it } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code';
import type { AgentCapability, AgentExecution, AgentProvider } from '../../domain/agents/types';
import { requireCommandAgentProvider } from './command-provider.js';

describe('requireCommandAgentProvider', () => {
  it('accepts command-based providers without changing command construction', () => {
    const provider = new ClaudeCodeProvider();
    expect(requireCommandAgentProvider(provider).buildCommand({ worktreePath: '/tmp/w', sessionId: 's' }))
      .toEqual(provider.buildCommand({ worktreePath: '/tmp/w', sessionId: 's' }));
  });

  it('rejects execution-only providers at the legacy command boundary', () => {
    const provider: AgentProvider = {
      name: 'codex',
      capabilities: new Set<AgentCapability>(),
      createExecution: async (): Promise<AgentExecution> => ({
        id: 'execution-1',
        metadata: { provider: 'codex', transport: 'process' },
        waitForResult: async () => ({ version: 1, runId: 'run-1', status: 'completed', provider: 'codex', commits: [] }),
        interrupt: async () => {},
        kill: async () => {},
        captureOutput: async () => '',
        captureSession: async () => undefined,
      }),
    };
    expect(() => requireCommandAgentProvider(provider)).toThrow("agent provider 'codex' does not support command execution");
  });
});
