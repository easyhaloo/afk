import { describe, expect, it } from 'vitest';
import { AGENT_EXECUTION_MODES, isAgentExecutionMode } from '../src/agent-execution-mode.js';

describe('the agent execution mode vocabulary', () => {
  it('names the modes an agent run can use', () => {
    expect([...AGENT_EXECUTION_MODES]).toEqual(['interactive', 'batch']);
  });

  it('accepts every mode it names', () => {
    for (const mode of AGENT_EXECUTION_MODES) {
      expect(isAgentExecutionMode(mode)).toBe(true);
    }
  });

  it('refuses anything else', () => {
    expect(isAgentExecutionMode('main')).toBe(false);
    expect(isAgentExecutionMode('afk')).toBe(false);
    expect(isAgentExecutionMode('')).toBe(false);
    expect(isAgentExecutionMode(undefined)).toBe(false);
    expect(isAgentExecutionMode(null)).toBe(false);
    expect(isAgentExecutionMode(7)).toBe(false);
  });
});
