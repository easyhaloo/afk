import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@afk/core';
import { observeRun, queryExecutionHistory, type RunEventQueryPort } from '../src/index.js';

const context = {
  traceId: 'trace-1', runId: 'run-1', workItemId: 'work-1', profileId: 'profile-1', attempt: 1,
  actor: { kind: 'system' as const, id: 'system-1' },
};

function event(sequence: number, kind: 'run.requested' | 'run.started', status = 'pending'): RunEvent {
  return {
    id: `event-${sequence}`, schemaVersion: 1, type: kind, sequence,
    occurredAt: `2026-09-30T00:00:0${sequence}.000Z`, observedAt: `2026-09-30T00:00:0${sequence}.001Z`,
    context, correlationId: context.runId,
    data: kind === 'run.requested'
      ? { kind, run: { id: context.runId, workItemId: context.workItemId, profileId: context.profileId, attempt: 1, status: status as 'pending' } }
      : { kind },
    integrity: { hash: `hash-${sequence}` },
  } as RunEvent;
}

function port(recorded = [event(1, 'run.requested'), event(2, 'run.started')]): RunEventQueryPort {
  const runs = new Map<string, RunEvent[]>([
    ['run-1', recorded],
  ]);
  return {
    async *read(runId) { yield* runs.get(runId) ?? []; },
    async listRuns() { return [...runs.keys()]; },
    async verify(runId) { return { valid: true, lastSequence: runs.get(runId)?.length ?? 0 }; },
  };
}

describe('run observation facade', () => {
  it('exposes only verified usage belonging to this work item in execution history', async () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const recorded: RunEvent = { ...event(3, 'run.started'), type: 'agent.session_recorded', data: { kind: 'agent.session_recorded', sessionId: 'session-1', usage } };
    const deps = port([event(1, 'run.requested'), event(2, 'run.started'), recorded]);
    expect((await queryExecutionHistory({}, deps)).executions[0]).toMatchObject({ usage, status: 'running' });
    expect((await queryExecutionHistory({}, { ...deps, verify: async () => ({ valid: false, lastSequence: 2 }) })).executions).toEqual([]);
    expect((await queryExecutionHistory({}, { ...deps, verify: async () => ({ valid: true, lastSequence: 2 }) })).executions[0]).not.toHaveProperty('usage');
    const foreign = { ...recorded, context: { ...context, workItemId: 'other-work' } };
    expect((await queryExecutionHistory({}, port([event(1, 'run.requested'), event(2, 'run.started'), foreign]))).executions[0]).not.toHaveProperty('usage');
    const otherExecution = { ...recorded, correlationId: 'other-execution' };
    expect((await queryExecutionHistory({}, port([event(1, 'run.requested'), event(2, 'run.started'), otherExecution]))).executions[0]).not.toHaveProperty('usage');
  });

  it('returns the verified event timeline and replayed state', async () => {
    await expect(observeRun('run-1', port())).resolves.toMatchObject({
      runId: 'run-1',
      events: { length: 2 },
      state: { sequence: 2, run: { status: 'running' } },
      integrity: { valid: true, lastSequence: 2 },
    });
  });

  it('queries summaries with work-item filtering and a cursor', async () => {
    const deps = port();
    await expect(queryExecutionHistory({ workItemId: 'work-1', limit: 1 }, deps)).resolves.toEqual({
      executions: [{ runId: 'run-1', workItemId: 'work-1', profileId: 'profile-1', attempt: 1, status: 'running', phase: undefined, sequence: 2, terminal: false, startedAt: '2026-09-30T00:00:02.000Z' }],
      nextCursor: undefined,
    });
  });

  it('only exposes a verified start event, without treating a request as a start', async () => {
    expect((await queryExecutionHistory({}, port([event(1, 'run.requested')]))).executions[0]).not.toHaveProperty('startedAt');
    const deps = port();
    expect((await queryExecutionHistory({}, { ...deps, verify: async () => ({ valid: false, lastSequence: 1 }) })).executions).toEqual([]);
    expect((await queryExecutionHistory({}, { ...deps, verify: async () => ({ valid: true, lastSequence: 1 }) })).executions[0]).not.toHaveProperty('startedAt');
  });

  it('isolates invalid or non-replayable runs while returning healthy executions', async () => {
    const healthy = port();
    const deps: RunEventQueryPort = {
      async *read(runId) {
        if (runId === 'broken-run') throw new Error("run 'broken-run' event integrity: integrity_mismatch");
        if (runId === 'non-replayable') {
          yield { ...event(1, 'run.requested'), type: 'qa.started', data: { kind: 'qa.started' } } as RunEvent;
          return;
        }
        yield* healthy.read(runId);
      },
      async listRuns() { return ['broken-run', 'non-replayable', 'run-1']; },
      async verify(runId) {
        if (runId === 'broken-run') return { valid: false, lastSequence: 0, reason: 'integrity_mismatch' };
        if (runId === 'non-replayable') return { valid: true, lastSequence: 1 };
        return healthy.verify(runId);
      },
    };

    await expect(queryExecutionHistory({}, deps)).resolves.toMatchObject({
      executions: [{ runId: 'run-1' }],
    });
  });
});
