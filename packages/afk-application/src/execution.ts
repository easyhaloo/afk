import {
  decide,
  replay,
  type Decision,
  type EventChainIntegrity,
  type RunAggregate,
  type RunCommand,
  type RunEvent,
  type RunEventDraft,
} from '@afk/core';
import type { RunCommandPorts, RunEventQueryPort } from './ports.js';

export interface LoadedRun {
  /** The events the hash chain vouches for — the verified prefix. */
  events: readonly RunEvent[];
  state: RunAggregate;
  /** What the chain vouches for, and where it stops if it broke. */
  integrity: EventChainIntegrity;
}

export interface DecideRunCommandInput {
  runId: string;
  command: RunCommand;
}

export interface RunCommandDecision {
  runId: string;
  command: RunCommand;
  state: RunAggregate;
  decision: Decision;
}

export interface StartRunResult extends RunCommandDecision {
  started: boolean;
}

/**
 * Read a run's events, keeping only the prefix the hash chain vouches for.
 *
 * Verification comes first on purpose: a stream that fails its chain must not
 * reach the reducer, because the state it produced would be a state derived
 * from a forgery, and a reader would have no way to tell.
 */
export async function readVerifiedEvents(
  runId: string,
  events: RunEventQueryPort,
): Promise<{ events: RunEvent[]; integrity: EventChainIntegrity }> {
  const integrity = await events.verify(runId);
  const recorded: RunEvent[] = [];
  for await (const event of events.read(runId)) recorded.push(event);
  // On an intact stream the boundary is past the last event, so nothing is
  // dropped; on a broken one it stops exactly where the chain stops.
  return { events: recorded.filter(event => event.sequence <= integrity.lastSequence), integrity };
}

export async function loadRun(runId: string, events: RunEventQueryPort): Promise<LoadedRun> {
  const verified = await readVerifiedEvents(runId, events);
  return { events: verified.events, state: replay(verified.events), integrity: verified.integrity };
}

export async function decideRunCommand(
  input: DecideRunCommandInput,
  ports: Pick<RunCommandPorts, 'events'>,
): Promise<RunCommandDecision> {
  const loaded = await loadRun(input.runId, ports.events);
  return {
    runId: input.runId,
    command: input.command,
    state: loaded.state,
    decision: decide(loaded.state, input.command),
  };
}

export async function startRun(
  input: { runId: string },
  ports: RunCommandPorts,
): Promise<StartRunResult> {
  const loaded = await loadRun(input.runId, ports.events);
  const command: RunCommand = { type: 'start', runId: input.runId };
  const decision = decide(loaded.state, command);
  if (!decision.accepted) {
    return { runId: input.runId, command, state: loaded.state, decision, started: false };
  }

  const context = loaded.events.at(-1)?.context;
  if (!context) {
    return {
      runId: input.runId,
      command,
      state: loaded.state,
      decision: { accepted: false, reason: 'run_context_missing', effects: [] },
      started: false,
    };
  }

  // Through the writer, so the event is stamped, logged, counted and traced
  // the way every other audit event is.
  await ports.audit.record(context, { kind: 'run.started' });
  return { runId: input.runId, command, state: loaded.state, decision, started: true };
}
