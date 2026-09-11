import type { RunEvent } from './events';
import { initialRunAggregate, type RunAggregate, type RunStatus } from './model';

export class RunEventSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunEventSequenceError';
  }
}

export class RunEventTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunEventTransitionError';
  }
}

export function evolve(state: RunAggregate, event: RunEvent): RunAggregate {
  if (event.sequence !== state.sequence + 1) {
    throw new RunEventSequenceError(`expected sequence ${state.sequence + 1}, received ${event.sequence}`);
  }
  if (state.run && state.run.id !== event.context.runId) {
    throw new RunEventTransitionError(`event run '${event.context.runId}' does not match aggregate run '${state.run.id}'`);
  }
  if (state.terminal) {
    throw new RunEventTransitionError(`cannot apply '${event.type}' after terminal event`);
  }

  const next = { ...state, sequence: event.sequence };
  switch (event.data.kind) {
    case 'run.requested':
      if (state.run) throw new RunEventTransitionError('run has already been requested');
      if (event.data.run.id !== event.context.runId) throw new RunEventTransitionError('requested run id must match event context');
      if (event.data.run.status !== 'pending') throw new RunEventTransitionError('requested run must start pending');
      return { ...next, run: event.data.run };
    case 'run.started':
      requireRunStatus(state, 'pending', event.type);
      return { ...next, run: { ...state.run!, status: 'running' } };
    case 'lease.granted':
    case 'workspace.prepared':
    case 'change.created':
    case 'change.merge_verified':
    case 'decision.made':
    case 'effect.started':
    case 'effect.completed':
    case 'failure.classified':
      if (!state.run) throw new RunEventTransitionError(`event '${event.type}' requires a requested run`);
      return next;
    case 'step.started':
      requireRunStatus(state, 'running', event.type);
      if (state.activeStep) throw new RunEventTransitionError(`step '${state.activeStep}' is already active`);
      return {
        ...next,
        run: { ...state.run!, phase: event.data.phase },
        activeStep: event.data.stepId,
      };
    case 'step.completed':
      requireRunStatus(state, 'running', event.type);
      if (state.activeStep !== event.data.stepId) throw new RunEventTransitionError(`completed step '${event.data.stepId}' is not active`);
      return { ...next, activeStep: undefined };
    case 'human_gate.opened':
      requireRunStatus(state, 'running', event.type);
      if (state.activeStep) throw new RunEventTransitionError('cannot open human gate while a step is active');
      return {
        ...next,
        run: { ...state.run!, status: 'awaiting_human' },
        humanGateId: event.data.gateId,
      };
    case 'human_gate.approved':
      requireRunStatus(state, 'awaiting_human', event.type);
      if (state.humanGateId !== event.data.gateId) throw new RunEventTransitionError(`approved gate '${event.data.gateId}' is not active`);
      return {
        ...next,
        run: { ...state.run!, status: 'running' },
        humanGateId: undefined,
      };
    case 'run.finished':
      if (!state.run || (state.run.status !== 'running' && !(state.run.status === 'pending' && event.data.outcome === 'cancelled'))) {
        throw new RunEventTransitionError(`event '${event.type}' requires a running run, except pending cancellation`);
      }
      if (state.activeStep) throw new RunEventTransitionError('cannot finish run while a step is active');
      return {
        ...next,
        run: { ...state.run!, status: event.data.outcome },
        terminal: true,
      };
  }
}

export function replay(events: Iterable<RunEvent>): RunAggregate {
  let state = initialRunAggregate();
  for (const event of events) state = evolve(state, event);
  return state;
}

function requireRunStatus(state: RunAggregate, expected: RunStatus, eventType: string): void {
  if (!state.run || state.run.status !== expected) {
    throw new RunEventTransitionError(`event '${eventType}' requires run status '${expected}'`);
  }
}
