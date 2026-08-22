import { describe, expect, it } from 'vitest';
import { decide, evolve, initialRunAggregate, replay, RunEventSequenceError, RunEventTransitionError, type RunEvent, type RunEventData } from './index';

const context = {
  traceId: 'trace-1',
  runId: 'run-1',
  workItemId: '42',
  profileId: 'local-github-codex',
  attempt: 1,
  actor: { kind: 'loop' as const, id: 'loop-1' },
};

function event<T extends RunEventData>(sequence: number, data: T): RunEvent<T> {
  return {
    id: `event-${sequence}`,
    schemaVersion: 1,
    type: data.kind,
    sequence,
    occurredAt: `2026-08-23T00:00:0${sequence}.000Z`,
    observedAt: `2026-08-23T00:00:0${sequence}.001Z`,
    context,
    correlationId: context.runId,
    data,
    integrity: { hash: `hash-${sequence}` },
  };
}

const requested = () => event(1, {
  kind: 'run.requested' as const,
  run: {
    id: context.runId,
    workItemId: context.workItemId,
    profileId: context.profileId,
    attempt: 1,
    status: 'pending' as const,
  },
});

describe('Run reducer', () => {
  it('replays an implementation, human gate, and completion timeline deterministically', () => {
    const state = replay([
      requested(),
      event(2, { kind: 'run.started' }),
      event(3, { kind: 'step.started', stepId: 'implementation', phase: 'implementation' }),
      event(4, { kind: 'step.completed', stepId: 'implementation', outcome: 'succeeded' }),
      event(5, { kind: 'human_gate.opened', gateId: 'merge-approval', reason: 'root merge requires review' }),
      event(6, { kind: 'human_gate.approved', gateId: 'merge-approval', approverId: 'user-1' }),
      event(7, { kind: 'run.finished', outcome: 'succeeded' }),
    ]);

    expect(state).toMatchObject({
      sequence: 7,
      terminal: true,
      run: { id: context.runId, status: 'succeeded', phase: 'implementation' },
    });
  });

  it('requires strictly increasing event sequences', () => {
    const state = evolve(initialRunAggregate(), requested());
    expect(() => evolve(state, event(3, { kind: 'run.started' }))).toThrow(RunEventSequenceError);
  });

  it('rejects a completed step that does not match the active step', () => {
    const state = replay([
      requested(),
      event(2, { kind: 'run.started' }),
      event(3, { kind: 'step.started', stepId: 'implementation', phase: 'implementation' }),
    ]);
    expect(() => evolve(state, event(4, { kind: 'step.completed', stepId: 'verification', outcome: 'succeeded' }))).toThrow(RunEventTransitionError);
  });

  it('does not make effects directly; it returns a decision for the coordinator', () => {
    const pending = evolve(initialRunAggregate(), requested());
    expect(decide(pending, { type: 'start', runId: context.runId })).toEqual({
      accepted: true,
      effects: [{ kind: 'start_run', runId: context.runId }],
    });
    expect(decide(pending, { type: 'finish', runId: context.runId, outcome: 'succeeded' })).toMatchObject({
      accepted: false,
      reason: 'run_not_finishable',
    });
  });
});
