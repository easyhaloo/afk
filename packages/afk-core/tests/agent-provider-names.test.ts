import { describe, expect, it } from 'vitest';
import { AGENT_PROVIDER_NAMES, isAgentProviderName } from '../src/agent-provider-names.js';

describe('the agent provider vocabulary', () => {
  it('names the providers AFK can drive', () => {
    expect([...AGENT_PROVIDER_NAMES]).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'pi',
      'opencode',
      'copilot',
    ]);
  });

  it('accepts every provider it names', () => {
    for (const name of AGENT_PROVIDER_NAMES) {
      expect(isAgentProviderName(name)).toBe(true);
    }
  });

  it('refuses anything else', () => {
    expect(isAgentProviderName('claude')).toBe(false);
    expect(isAgentProviderName('gemini')).toBe(false);
    expect(isAgentProviderName('')).toBe(false);
    expect(isAgentProviderName(undefined)).toBe(false);
    expect(isAgentProviderName(null)).toBe(false);
    expect(isAgentProviderName(7)).toBe(false);
  });
});
