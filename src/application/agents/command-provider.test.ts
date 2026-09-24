import { describe, expect, it } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code';
import type { AgentProvider } from '../../domain/agents/types';
import { requireCommandAgentProvider } from './command-provider';

describe('requireCommandAgentProvider', () => {
  it('accepts command-based providers without changing command construction', () => {
    const provider = new ClaudeCodeProvider();
    expect(requireCommandAgentProvider(provider).buildCommand({ worktreePath: '/tmp/w', sessionId: 's' }))
      .toEqual(provider.buildCommand({ worktreePath: '/tmp/w', sessionId: 's' }));
  });

  it('rejects execution-only providers at the legacy command boundary', () => {
    const provider = { name: 'codex', capabilities: new Set(), createExecution: async () => ({}) } as AgentProvider;
    expect(() => requireCommandAgentProvider(provider)).toThrow("agent provider 'codex' does not support command execution");
  });
});
