import { describe, expect, it } from 'vitest';
import { PlanExecutor } from './plan-executor.js';
import type { WorkflowTemplate } from '../../domain/templates/types.js';

describe('PlanExecutor', () => {
  it('waits for running siblings before propagating an audit error', async () => {
    const sibling = Promise.withResolvers<void>();
    const siblingStarted = Promise.withResolvers<void>();
    const auditError = new Error('audit write failed');
    const executor = new PlanExecutor({
      executeAgent: async () => { throw new Error('unexpected agent step'); },
      executeSystem: async step => {
        if (step.id === 'publish') throw auditError;
        siblingStarted.resolve();
        await sibling.promise;
        return { stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' };
      },
    });
    const execution = executor.execute({ name: 'parallel', version: 1, steps: [
      { id: 'publish', kind: 'system', action: 'publish-change' },
      { id: 'queue', kind: 'system', action: 'queue-qa' },
    ] });
    const rejected = expect(execution).rejects.toBe(auditError);
    try {
      await siblingStarted.promise;
      const pending = Symbol('pending');
      await expect(Promise.race([execution, new Promise(resolve => setImmediate(resolve, pending))])).resolves.toBe(pending);
    } finally {
      sibling.resolve();
      await rejected;
    }
  });

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
