import {
  decide,
  replay,
  type Decision,
  type RunAggregate,
  type RunCommand,
  type RunEvent,
  type RunEventDraft,
} from '@afk/core';
import type { RunCommandPorts, RunEventQueryPort } from './ports.js';

export interface LoadedRun {
  events: readonly RunEvent[];
  state: RunAggregate;
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

export async function loadRun(runId: string, events: RunEventQueryPort): Promise<LoadedRun> {
  const recorded: RunEvent[] = [];
  for await (const event of events.read(runId)) recorded.push(event);
  return { events: recorded, state: replay(recorded) };
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

  const event: RunEventDraft = {
    id: ports.ids.next(),
    schemaVersion: 1,
    type: 'run.started',
    occurredAt: ports.clock.now().toISOString(),
    context,
    correlationId: context.runId,
    data: { kind: 'run.started' },
  };
  await ports.events.append([event]);
  return { runId: input.runId, command, state: loaded.state, decision, started: true };
}
