import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunEventDraft } from '@afk/core';
import { decideRunCommand, startRun, type RunCommandPorts } from '../src/index.js';

const context = {
  traceId: 'trace-1',
  runId: 'run-1',
  workItemId: 'work-1',
  profileId: 'profile-1',
  attempt: 1,
  actor: { kind: 'cli' as const, id: 'cli-1' },
};

const requested: RunEvent = {
  id: 'event-1',
  schemaVersion: 1,
  type: 'run.requested',
  sequence: 1,
  occurredAt: '2026-09-30T00:00:00.000Z',
  observedAt: '2026-09-30T00:00:00.001Z',
  context,
  correlationId: context.runId,
  data: {
    kind: 'run.requested',
    run: { id: 'run-1', workItemId: 'work-1', profileId: 'profile-1', attempt: 1, status: 'pending' },
  },
  integrity: { hash: 'hash-1' },
};

function ports(events: readonly RunEvent[] = [requested]): RunCommandPorts & { appended: RunEventDraft[][] } {
  const appended: RunEventDraft[][] = [];
  return {
    events: {
      async *read() {
        yield* events;
      },
      async listRuns() { return ['run-1']; },
      async verify() { return { valid: true, lastSequence: events.length }; },
      async append(value) { appended.push([...value]); return { runId: 'run-1', firstSequence: 2, lastSequence: 2, lastHash: 'hash-2' }; },
    },
    ids: { next: vi.fn(() => 'event-2') },
    clock: { now: () => new Date('2026-09-30T00:00:02.000Z') },
    appended,
  };
}

describe('run application facade', () => {
  it('decides commands from the replayed aggregate without executing effects', async () => {
    const deps = ports();
    await expect(decideRunCommand({ runId: 'run-1', command: { type: 'start', runId: 'run-1' } }, deps)).resolves.toMatchObject({
      decision: { accepted: true, effects: [{ kind: 'start_run', runId: 'run-1' }] },
      state: { run: { status: 'pending' } },
    });
    expect(deps.appended).toHaveLength(0);
  });

  it('persists only the accepted run.started event for startRun', async () => {
    const deps = ports();
    await expect(startRun({ runId: 'run-1' }, deps)).resolves.toMatchObject({ started: true, decision: { accepted: true } });
    expect(deps.appended).toHaveLength(1);
    expect(deps.appended[0]).toMatchObject([{
      id: 'event-2',
      type: 'run.started',
      occurredAt: '2026-09-30T00:00:02.000Z',
      context,
      data: { kind: 'run.started' },
    }]);
  });

  it('does not append when the core decision rejects the command', async () => {
    const deps = ports([requested, {
      ...requested,
      id: 'event-2',
      sequence: 2,
      type: 'run.started',
      data: { kind: 'run.started' },
      integrity: { hash: 'hash-2' },
    }]);
    await expect(startRun({ runId: 'run-1' }, deps)).resolves.toMatchObject({ started: false, decision: { reason: 'run_not_pending' } });
    expect(deps.appended).toHaveLength(0);
  });
});
