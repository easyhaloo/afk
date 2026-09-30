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

function port(): RunEventQueryPort {
  const runs = new Map<string, RunEvent[]>([
    ['run-1', [event(1, 'run.requested'), event(2, 'run.started')]],
  ]);
  return {
    async *read(runId) { yield* runs.get(runId) ?? []; },
    async listRuns() { return [...runs.keys()]; },
    async verify(runId) { return { valid: true, lastSequence: runs.get(runId)?.length ?? 0 }; },
  };
}

describe('run observation facade', () => {
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
      executions: [{ runId: 'run-1', workItemId: 'work-1', profileId: 'profile-1', attempt: 1, status: 'running', phase: undefined, sequence: 2, terminal: false }],
      nextCursor: undefined,
    });
  });
});
