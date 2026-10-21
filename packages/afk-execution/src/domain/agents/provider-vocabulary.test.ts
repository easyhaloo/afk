import { describe, expect, it } from 'vitest';
import { createAgentProvider, ensureBuiltinAgentProviders } from './index.js';
import { listAgentProviders } from './registry.js';
import { AGENT_PROVIDER_NAMES } from '@afk/core';
import { StepSchema, WorkflowTemplateSchema } from '../templates/types.js';

describe('the agent provider vocabulary', () => {
  it('names a provider the registry can create', () => {
    ensureBuiltinAgentProviders();
    for (const name of AGENT_PROVIDER_NAMES) {
      expect(() => createAgentProvider(name)).not.toThrow();
    }
  });

  it('names every provider the registry knows', () => {
    ensureBuiltinAgentProviders();
    expect([...listAgentProviders()].sort()).toEqual([...AGENT_PROVIDER_NAMES].sort());
  });

  it('lets a template name every provider and no other', () => {
    const step = (provider: string) => ({
      id: 'implement',
      kind: 'agent',
      role: 'developer',
      prompt: 'do the work',
      provider,
    });
    for (const name of AGENT_PROVIDER_NAMES) {
      expect(WorkflowTemplateSchema.shape.defaultProvider.safeParse(name).success).toBe(true);
      expect(StepSchema.safeParse(step(name)).success).toBe(true);
    }
    expect(WorkflowTemplateSchema.shape.defaultProvider.safeParse('gemini').success).toBe(false);
    expect(StepSchema.safeParse(step('gemini')).success).toBe(false);
  });
});
