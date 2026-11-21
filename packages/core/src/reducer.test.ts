import { describe, expect, it } from 'vitest';
import { decide, evolve, initialRunAggregate, replay, RunEventSequenceError, RunEventTransitionError, type RunEvent, type RunEventData } from './index.js';

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
  it.each(['succeeded', 'failed', 'cancelled'] as const)('accepts completed evidence mirror facts after terminal %s without reopening business transitions', terminalOutcome => {
    const finished = replay([requested(), event(2, { kind: 'run.started' }), event(3, { kind: 'run.finished', outcome: terminalOutcome })]);
    for (const outcome of ['succeeded', 'failed'] as const) {
      const receipt = event(4, { kind: 'effect.completed', effectKind: 'evidence.mirror', idempotencyKey: 'mirror', outcome });
      const mirrored = evolve(finished, receipt);
      expect(mirrored).toEqual({ ...finished, sequence: 4 });
      expect(decide(mirrored, { type: 'start', runId: context.runId })).toMatchObject({ accepted: false, reason: 'run_terminal' });
      expect(() => evolve(finished, { ...receipt, sequence: 5 })).toThrow(RunEventSequenceError);
      expect(() => evolve(finished, { ...receipt, context: { ...context, runId: 'foreign' } })).toThrow(RunEventTransitionError);
      for (const data of [
        { kind: 'run.started' as const }, { kind: 'qa.passed' as const },
        { kind: 'run.finished' as const, outcome: 'succeeded' as const },
        { kind: 'effect.started' as const, effectKind: 'evidence.mirror', idempotencyKey: 'mirror' },
        { kind: 'effect.completed' as const, effectKind: 'evidence.mirror.other', idempotencyKey: 'other', outcome },
        { kind: 'effect.completed' as const, effectKind: 'publish', idempotencyKey: 'publish', outcome },
      ]) expect(() => evolve(mirrored, event(5, data))).toThrow(RunEventTransitionError);
    }
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('accepts only completed observability metadata after terminal %s without changing its result', outcome => {
    const finished = replay([requested(), event(2, { kind: 'run.started' }), event(3, { kind: 'run.finished', outcome })]);
    const delivery = evolve(finished, event(4, { kind: 'effect.completed', effectKind: 'observability.delivery', idempotencyKey: 'delivery', outcome: 'failed' }));
    expect(delivery).toEqual({ ...finished, sequence: 4 });
    expect(decide(delivery, { type: 'start', runId: context.runId })).toMatchObject({ accepted: false, reason: 'run_terminal' });
    for (const data of [
      { kind: 'run.started' as const }, { kind: 'qa.passed' as const },
      { kind: 'effect.started' as const, effectKind: 'observability.delivery', idempotencyKey: 'delivery' },
      { kind: 'effect.completed' as const, effectKind: 'publish', idempotencyKey: 'publish', outcome: 'succeeded' as const },
    ]) expect(() => evolve(delivery, event(5, data))).toThrow(RunEventTransitionError);
  });

  it('replays a recorded workflow without changing scheduling state', () => {
    const state = replay([requested(), event(2, {
      kind: 'workflow.recorded', name: 'issue-implementation', version: 1,
      steps: [{ id: 'implement', kind: 'agent', dependsOn: [], provider: 'opencode', executionMode: 'interactive' }],
    })]);
    expect(state).toMatchObject({ sequence: 2, terminal: false, run: { status: 'pending' } });
    expect(state.activeStep).toBeUndefined();
  });
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

  it('allows a not-claimed pending run to terminate as cancelled', () => {
    const state = replay([
      requested(),
      event(2, { kind: 'run.finished', outcome: 'cancelled', reason: 'not_claimed' }),
    ]);

    expect(state).toMatchObject({
      sequence: 2,
      terminal: true,
      run: { id: context.runId, status: 'cancelled' },
    });
  });

  it('replays one implementation, QA, and provider-confirmed PR without prematurely ending the run', () => {
    const verified = [requested(), event(2, { kind: 'run.started' }), event(3, { kind: 'implementation.completed' }),
      event(4, { kind: 'qa.started' }), event(5, { kind: 'qa.passed' }),
      event(6, { kind: 'change.published', changeId: '159', url: 'https://github.com/team/project/pull/159' })];
    expect(replay([...verified, event(7, { kind: 'human_gate.opened', gateId: 'merge:159', reason: 'awaiting human merge' })]))
      .toMatchObject({ sequence: 7, terminal: false, run: { status: 'awaiting_human' } });
    expect(replay([...verified, event(7, { kind: 'change.merge_verified', changeId: '159', targetBranch: 'main', child: true }),
      event(8, { kind: 'run.finished', outcome: 'succeeded' })]))
      .toMatchObject({ sequence: 8, terminal: true, run: { status: 'succeeded' } });
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

  it('accepts only artifact upload receipts after termination without reopening the run', () => {
    const finished = replay([requested(), event(2, { kind: 'run.started' }), event(3, { kind: 'run.finished', outcome: 'succeeded' })]);
    const receipt = evolve(finished, event(4, { kind: 'effect.completed', effectKind: 'artifact.upload', idempotencyKey: 'upload-1', outcome: 'succeeded' }));
    expect(receipt).toEqual({ ...finished, sequence: 4 });
    expect(decide(receipt, { type: 'start', runId: context.runId })).toMatchObject({ accepted: false, reason: 'run_terminal' });
    expect(() => evolve(receipt, event(5, { kind: 'effect.completed', effectKind: 'publish', idempotencyKey: 'publish-1', outcome: 'succeeded' }))).toThrow(RunEventTransitionError);
    expect(() => evolve(receipt, event(5, { kind: 'qa.passed' }))).toThrow(RunEventTransitionError);
  });
});
