import { describe, expect, it } from 'vitest';
import { PlanExecutor } from './plan-executor.js';
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

  it.each(['agent', 'system'] as const)('does not let a conditional %s step bypass another failed prerequisite', async kind => {
    const seen: string[] = [];
    const execute = async (step: { id: string }) => {
      seen.push(step.id);
      return { stepId: step.id, status: 'failed' as const, startedAt: 'now', completedAt: 'now' };
    };
    const executor = new PlanExecutor({ executeAgent: execute, executeSystem: execute });
    const recovery = kind === 'system' ? { kind, action: 'publish-change' } : { kind, role: 'implementer', prompt: 'fix' };
    const template: WorkflowTemplate = { name: 'required-prerequisite', version: 1, steps: [
      { id: 'review', role: 'reviewer', prompt: 'review' },
      { id: 'policy', role: 'verifier', prompt: 'required policy' },
      { id: 'recover', ...recovery, dependsOn: ['review', 'policy'], when: { step: 'review', equals: 'failed' } },
    ] };

    const results = await executor.execute(template);

    expect(seen).toEqual(['review', 'policy']);
    expect(results.recover).toBeUndefined();
  });

  it.each(['aborted', 'timed_out'] as const)('does not bypass an unrelated %s prerequisite', async status => {
    const seen: string[] = [];
    const execute = async (step: { id: string }) => {
      seen.push(step.id);
      return { stepId: step.id, status: step.id === 'review' ? 'failed' as const : status, startedAt: 'now', completedAt: 'now' };
    };
    const executor = new PlanExecutor({ executeAgent: execute, executeSystem: execute });
    const template: WorkflowTemplate = { name: 'stopped-prerequisite', version: 1, steps: [
      { id: 'review', role: 'reviewer', prompt: 'review' },
      { id: 'authorization', role: 'verifier', prompt: 'authorize' },
      { id: 'publish', kind: 'system', action: 'publish-change', dependsOn: ['review', 'authorization'],
        when: { step: 'review', equals: 'failed' } },
    ] };

    await executor.execute(template);

    expect(seen).toEqual(['review', 'authorization']);
  });

  it('blocks a conditional step when another prerequisite was skipped', async () => {
    const seen: string[] = [];
    const execute = async (step: { id: string }) => {
      seen.push(step.id);
      return { stepId: step.id, status: 'failed' as const, startedAt: 'now', completedAt: 'now' };
    };
    const executor = new PlanExecutor({ executeAgent: execute, executeSystem: execute });
    const template: WorkflowTemplate = { name: 'skipped-prerequisite', version: 1, steps: [
      { id: 'review', role: 'reviewer', prompt: 'review' },
      { id: 'policy', role: 'verifier', prompt: 'authorize', dependsOn: ['review'], when: { step: 'review', equals: 'completed' } },
      { id: 'publish', kind: 'system', action: 'publish-change', dependsOn: ['review', 'policy'],
        when: { step: 'review', equals: 'failed' } },
    ] };

    const results = await executor.execute(template);

    expect(seen).toEqual(['review']);
    expect(results.policy).toBeUndefined();
    expect(results.publish).toBeUndefined();
  });

  it('still runs conditional recovery after its other prerequisite succeeds', async () => {
    const seen: string[] = [];
    const execute = async (step: { id: string }) => {
      seen.push(step.id);
      return { stepId: step.id, status: step.id === 'review' ? 'failed' as const : 'completed' as const,
        startedAt: 'now', completedAt: 'now' };
    };
    const executor = new PlanExecutor({ executeAgent: execute, executeSystem: execute });
    const template: WorkflowTemplate = { name: 'authorized-recovery', version: 1, steps: [
      { id: 'review', role: 'reviewer', prompt: 'review' },
      { id: 'authorization', role: 'verifier', prompt: 'authorize' },
      { id: 'recover', role: 'implementer', prompt: 'fix', dependsOn: ['review', 'authorization'],
        when: { step: 'review', equals: 'failed' } },
    ] };

    const results = await executor.execute(template);

    expect(seen).toEqual(['review', 'authorization', 'recover']);
    expect(results.recover?.status).toBe('completed');
  });

  it('waits for a condition-only prerequisite before dispatching recovery', async () => {
    const seen: string[] = [];
    const executor = new PlanExecutor({
      executeAgent: async step => {
        seen.push(step.id);
        return { stepId: step.id, status: 'failed', startedAt: 'now', completedAt: 'now' };
      },
      executeSystem: async (step, results) => {
        expect(results.review?.status).toBe('failed');
        seen.push(step.id);
        return { stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' };
      },
    });
    const template: WorkflowTemplate = { name: 'condition-order', version: 1, steps: [
      { id: 'recover', kind: 'system', action: 'publish-change', when: { step: 'review', equals: 'failed' } },
      { id: 'review', role: 'reviewer', prompt: 'review' },
    ] };

    const results = await executor.execute(template);

    expect(seen).toEqual(['review', 'recover']);
    expect(results.recover?.status).toBe('completed');
  });

  it.each([
    { source: 'policy', equals: 'completed' },
    { source: 'policy', notEquals: 'failed' },
    { source: 'constructor', equals: 'completed' },
    { source: 'constructor', notEquals: 'failed' },
  ] as const)(
    'does not dispatch when a skipped condition source has no result: %j', async ({ source, ...condition }) => {
      const seen: string[] = [];
      const execute = async (step: { id: string }) => {
        seen.push(step.id);
        return { stepId: step.id, status: 'failed' as const, startedAt: 'now', completedAt: 'now' };
      };
      const executor = new PlanExecutor({ executeAgent: execute, executeSystem: execute });
      const template: WorkflowTemplate = { name: 'missing-condition-result', version: 1, steps: [
        { id: 'review', role: 'reviewer', prompt: 'review' },
        { id: source, role: 'verifier', prompt: 'authorize', when: { step: 'review', equals: 'completed' } },
        { id: 'publish', kind: 'system', action: 'publish-change', when: { step: source, ...condition } },
      ] };

      const results = await executor.execute(template);

      expect(seen).toEqual(['review']);
      expect(Object.hasOwn(results, source)).toBe(false);
      expect(results.publish).toBeUndefined();
    },
  );
});
