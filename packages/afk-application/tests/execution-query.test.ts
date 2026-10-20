import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@afk/core';
import {
  loadWorkItemExecution, queryWorkItemExecutions, replayRun, explainRun, loadRunTimeline, listExecutionRuns, projectAgentUsage,
  type WorkItemExecutionSummary, type RunEventQueryPort,
} from '../src/index.js';

const context = { traceId: 'trace', runId: 'run-1', workItemId: 'work-1', profileId: 'profile', attempt: 1, actor: { kind: 'system' as const, id: 'test' } };
const event = {
  id: 'one', schemaVersion: 1, sequence: 1, type: 'run.requested', occurredAt: '2026-09-30T00:00:00Z',
  observedAt: '2026-09-30T00:00:00Z', context, correlationId: 'run-1',
  data: { kind: 'run.requested', run: { id: 'run-1', workItemId: 'work-1', profileId: 'profile', attempt: 1, status: 'pending' } },
  integrity: { hash: 'hash' },
} as RunEvent;

function events(integrity = { valid: true, lastSequence: 1 }): RunEventQueryPort {
  return {
    async *read() { yield event; },
    async listRuns() { return ['run-1']; },
    async verify() { return integrity; },
  };
}

describe('execution queries', () => {
  it('sums the peak recorded usage per session without inventing missing or invalid usage', () => {
    const recorded = (sequence: number, sessionId: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }): RunEvent => ({
      ...event, sequence, type: 'agent.session_recorded', data: { kind: 'agent.session_recorded', sessionId, usage },
    });
    const first = recorded(2, 'session-1', { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    const latest = recorded(3, 'session-1', { inputTokens: 20, outputTokens: 3, totalTokens: 23 });
    const second = recorded(4, 'session-2', { inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    const zero = recorded(5, 'session-zero', { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const missing = recorded(6, 'session-1');
    const invalid = recorded(7, 'session-1', { inputTokens: NaN, outputTokens: 1, totalTokens: NaN });
    expect(projectAgentUsage([event, first, latest, second, zero, missing, invalid])).toEqual({ inputTokens: 25, outputTokens: 4, totalTokens: 29 });
    expect(projectAgentUsage([event, latest, first, second, zero])).toEqual({ inputTokens: 25, outputTokens: 4, totalTokens: 29 });
    expect(projectAgentUsage([zero])).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(projectAgentUsage([event, missing, invalid])).toBeUndefined();
    expect(first.data).toEqual({ kind: 'agent.session_recorded', sessionId: 'session-1', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  });

  it('hands verified timeline to the projection port and reports unreadable streams', async () => {
    const project = (timeline: { runId: string; integrity: { valid: boolean; reason?: string }; events: readonly RunEvent[] }) => ({
      summary: { runId: timeline.runId, executionId: timeline.runId, workItemId: 'work-1', status: 'queued' as const }, timeline,
    });
    const result = await loadWorkItemExecution('run-1', { events: events(), projection: { project } });
    expect(result.timeline).toMatchObject({ runId: 'run-1', events: [event], integrity: { valid: true } });
    const unreadable = { ...events(), async *read(): AsyncIterable<RunEvent> { yield event; throw new Error('unreadable stream'); } };
    expect((await loadWorkItemExecution('run-1', { events: unreadable, projection: { project } })).timeline)
      .toMatchObject({ events: [event], integrity: { valid: false, reason: 'unreadable stream' } });
    await expect(loadWorkItemExecution('', { events: events(), projection: { project } })).rejects.toThrow('runId is required');
  });

  it('refuses to replay an invalid stream and explains a missing run', async () => {
    await expect(replayRun('run-1', events({ valid: false, lastSequence: 0 }))).resolves.toMatchObject({
      explanation: 'cannot replay invalid event stream: unknown', state: undefined,
    });
  });

  it('filters, sorts, and pages summaries after the summary port supplies them', async () => {
    const summaries: WorkItemExecutionSummary[] = [
      { runId: 'run-a', executionId: 'a', workItemId: 'work-1', status: 'queued', startedAt: '2026-09-30T00:00:00Z' },
      { runId: 'run-c', executionId: 'c', workItemId: 'other', status: 'unknown' },
      { runId: 'run-b', executionId: 'b', workItemId: 'work-1', status: 'done', startedAt: '2026-09-30T00:00:00Z' },
    ];
    const ports = { summaries: { list: async () => summaries } };
    await expect(queryWorkItemExecutions({ workItemId: 'work-1', limit: 1 }, ports)).resolves.toMatchObject({ executions: [{ runId: 'run-b' }], nextCursor: 'run-b' });
    await expect(queryWorkItemExecutions({ workItemId: 'work-1', limit: 1, since: 'run-b' }, ports)).resolves.toMatchObject({ executions: [{ runId: 'run-a' }] });
    await expect(queryWorkItemExecutions({ workItemId: 'work-1', since: 'run-c' }, ports)).rejects.toThrow('execution cursor is not in the requested result set');
    await expect(queryWorkItemExecutions({ limit: 0 }, ports)).rejects.toThrow('limit');
    await expect(queryWorkItemExecutions({ workItemId: '' }, ports)).rejects.toThrow('workItemId');
  });

  it('lists run IDs and returns the raw verified timeline', async () => {
    await expect(listExecutionRuns(events())).resolves.toEqual(['run-1']);
    await expect(loadRunTimeline('run-1', events())).resolves.toMatchObject({
      runId: 'run-1', events: [event], integrity: { valid: true, lastSequence: 1 },
    });
  });

  it('replays a valid run and explains its current state without a legacy service', async () => {
    await expect(replayRun('run-1', events())).resolves.toMatchObject({ state: { run: { id: 'run-1' } } });
    await expect(explainRun('run-1', events())).resolves.toBe("run is 'pending' without an active step");
    await expect(explainRun('missing', { ...events(), async *read() {} })).resolves.toBe('no events recorded for this run');
  });
});
