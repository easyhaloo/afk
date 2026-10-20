import { describe, expect, it } from 'vitest';
import { PlanExecutor } from './plan-executor.js';
import { requireTemplate } from '../../domain/templates/registry.js';
import type { WorkflowTemplate } from '../../domain/templates/types.js';

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

  it('does not run a gated step when the step it gates on never ran', async () => {
    const seen: string[] = [];
    const executor = new PlanExecutor({
      executeAgent: async step => {
        seen.push(step.id);
        return { stepId: step.id, status: step.id === 'a' ? 'failed' : 'completed', startedAt: 'now', completedAt: 'now' };
      },
      executeSystem: async step => ({ stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' }),
    });
    // 'b' is filtered out because 'a' failed, so 'b' never produces a result.
    // 'c' gates on 'b' and must not run: the condition can never be satisfied.
    const template: WorkflowTemplate = { name: 'absent-prerequisite', version: 1, steps: [
      { id: 'a', role: 'implementer', prompt: 'a' },
      { id: 'b', role: 'verifier', prompt: 'b', dependsOn: ['a'] },
      { id: 'c', role: 'implementer', prompt: 'c', dependsOn: ['b'], when: { step: 'b', equals: 'completed' } },
    ] };

    await executor.execute(template);
    expect(seen).toEqual(['a']);
  });

  it('does not publish the branch of a failed implementation', async () => {
    const seen: string[] = [];
    const executor = new PlanExecutor({
      executeAgent: async step => {
        seen.push(step.id);
        return { stepId: step.id, status: step.id === 'implement' ? 'failed' : 'completed', startedAt: 'now', completedAt: 'now' };
      },
      executeSystem: async step => {
        seen.push(step.id);
        return { stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' };
      },
    });

    await executor.execute(requireTemplate('issue-implementation'));
    // 'verify-ac' never runs, so 'publish' must not push the branch and
    // 'queue-qa' must not move the backlog into verification.
    expect(seen).toEqual(['implement']);
  });

  it('publishes the branch when verification completed', async () => {
    const seen: string[] = [];
    const executor = new PlanExecutor({
      executeAgent: async step => {
        seen.push(step.id);
        return { stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' };
      },
      executeSystem: async step => {
        seen.push(step.id);
        return { stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' };
      },
    });

    await executor.execute(requireTemplate('issue-implementation'));
    expect(seen).toEqual(['implement', 'verify-ac', 'publish', 'queue-qa']);
  });
});
