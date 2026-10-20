import { describe, expect, it } from 'vitest';
import { replay, type RunEvent } from '@afk/core';
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

  it('produces an event stream the core reducer can replay when a level runs concurrently', async () => {
    // A plan level runs its steps at the same time, so the run's event stream
    // holds two active steps at once. The reducer used to model one active
    // step, so the second `step.started` was rejected and the run's spine
    // could no longer be replayed at all.
    const context = {
      traceId: 'trace-1', runId: 'run-1', workItemId: 'work-1',
      profileId: 'default', attempt: 1, actor: { kind: 'system' as const, id: 'runner' },
    };
    const events: RunEvent[] = [];
    const record = (data: RunEvent['data']) => {
      const sequence = events.length + 1;
      events.push({
        id: `event-${sequence}`, schemaVersion: 1, type: data.kind, sequence,
        occurredAt: 'now', observedAt: 'now', context, correlationId: context.runId,
        data, integrity: { hash: `hash-${sequence}` },
      } as RunEvent);
    };
    record({ kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId, profileId: context.profileId, attempt: 1, status: 'pending' } });
    record({ kind: 'run.started' });

    const executor = new PlanExecutor({
      executeAgent: async step => {
        record({ kind: 'step.started', stepId: step.id, phase: 'implementation' });
        // Yield, so the other step of the level starts before this one ends.
        await new Promise(resolve => setTimeout(resolve, 1));
        record({ kind: 'step.completed', stepId: step.id, outcome: 'succeeded' });
        return { stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' };
      },
      executeSystem: async step => ({ stepId: step.id, status: 'completed', startedAt: 'now', completedAt: 'now' }),
    });
    const template: WorkflowTemplate = { name: 'parallel', version: 1, steps: [
      { id: 'plan-frontend', role: 'planner', prompt: 'p' },
      { id: 'plan-backend', role: 'planner', prompt: 'p' },
    ] };

    await executor.execute(template);

    const started = events.filter(event => event.data.kind === 'step.started');
    expect(started).toHaveLength(2);
    // Both steps were active at the same time — the case the reducer used to reject.
    expect(events.findIndex(event => event.data.kind === 'step.started' && event.data.stepId === 'plan-backend'))
      .toBeLessThan(events.findIndex(event => event.data.kind === 'step.completed'));
    expect(() => replay(events)).not.toThrow();
  });
});
