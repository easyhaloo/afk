import { describe, expect, it } from 'vitest';
import type { ObservationContext, RunEvent, RunEventData } from '@afk/core';
import { decideRunCommand, startRun, type RunCommandPorts } from '../src/index.js';

type RecordedEvent = { context: ObservationContext; data: RunEventData };

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

function ports(events: readonly RunEvent[] = [requested]): RunCommandPorts & { recorded: RecordedEvent[] } {
  const recorded: RecordedEvent[] = [];
  return {
    events: {
      async *read() {
        yield* events;
      },
      async listRuns() { return ['run-1']; },
      async verify() { return { valid: true, lastSequence: events.length }; },
      // The writer appends; the store is not a second way in.
      async append() { throw new Error('audit events go through the writer'); },
    },
    audit: {
      async record(recordContext, data) {
        recorded.push({ context: recordContext, data });
        return { runId: 'run-1', firstSequence: 2, lastSequence: 2, lastHash: 'hash-2' };
      },
    },
    recorded,
  };
}

describe('run application facade', () => {
  it('decides commands from the replayed aggregate without executing effects', async () => {
    const deps = ports();
    await expect(decideRunCommand({ runId: 'run-1', command: { type: 'start', runId: 'run-1' } }, deps)).resolves.toMatchObject({
      decision: { accepted: true, effects: [{ kind: 'start_run', runId: 'run-1' }] },
      state: { run: { status: 'pending' } },
    });
    expect(deps.recorded).toHaveLength(0);
  });

  it('persists only the accepted run.started event for startRun', async () => {
    const deps = ports();
    await expect(startRun({ runId: 'run-1' }, deps)).resolves.toMatchObject({ started: true, decision: { accepted: true } });
    expect(deps.recorded).toHaveLength(1);
    // The writer stamps the event; the caller only says what happened.
    expect(deps.recorded[0]).toMatchObject({ context, data: { kind: 'run.started' } });
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
    expect(deps.recorded).toHaveLength(0);
  });
});
