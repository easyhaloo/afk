import { describe, expect, it } from 'vitest';
import { PlanExecutor } from './plan-executor';
import type { WorkflowTemplate } from '../templates/types';

describe('PlanExecutor', () => {
  it('runs a recovery step gated on a failed dependency', async () => {
    const seen: string[] = [];
    const executor = new PlanExecutor({
      executeAgent: async step => {
        seen.push(step.id);
        const failed = step.id === 'review';
        return { stepId: step.id, status: failed ? 'failed' : 'completed', startedAt: 'now', completedAt: 'now' };
      },
      executeSystem: async step => ({ stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' }),
    });
    const template: WorkflowTemplate = { name: 'recover', version: 1, steps: [
      { id: 'review', role: 'reviewer', prompt: 'review' },
      { id: 'fix', role: 'implementer', prompt: 'fix', dependsOn: ['review'], when: { step: 'review', equals: 'failed' } },
    ] };
    await executor.execute(template);
    expect(seen).toEqual(['review', 'fix']);
  });

  it('does not run an ordinary dependent step after its prerequisite fails', async () => {
    const seen: string[] = [];
    const executor = new PlanExecutor({
      executeAgent: async step => {
        seen.push(step.id);
        return { stepId: step.id, status: 'failed', startedAt: 'now', completedAt: 'now' };
      },
      executeSystem: async step => ({ stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' }),
    });
    const template: WorkflowTemplate = { name: 'blocked-dependency', version: 1, steps: [
      { id: 'implement', role: 'implementer', prompt: 'implement' },
      { id: 'verify', role: 'verifier', prompt: 'verify', dependsOn: ['implement'] },
    ] };

    await executor.execute(template);
    expect(seen).toEqual(['implement']);
  });
});
