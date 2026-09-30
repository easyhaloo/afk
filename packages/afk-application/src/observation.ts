import type { RunPhase, RunStatus } from '@afk/core';
import { loadRun } from './execution.js';
import type { RunEventQueryPort } from './ports.js';

export interface ObserveRunResult {
  runId: string;
  events: Awaited<ReturnType<typeof loadRun>>['events'];
  state: Awaited<ReturnType<typeof loadRun>>['state'];
  integrity: Awaited<ReturnType<RunEventQueryPort['verify']>>;
}

export async function observeRun(runId: string, ports: RunEventQueryPort): Promise<ObserveRunResult> {
  const loaded = await loadRun(runId, ports);
  return {
    runId,
    events: loaded.events,
    state: loaded.state,
    integrity: await ports.verify(runId),
  };
}

export async function listRunIds(ports: RunEventQueryPort): Promise<readonly string[]> {
  return ports.listRuns();
}

export async function explainRun(runId: string, ports: RunEventQueryPort): Promise<string> {
  const observed = await observeRun(runId, ports);
  if (!observed.state.run) return 'no events recorded for this run';
  if (observed.state.terminal) return `run finished with status '${observed.state.run.status}'`;
  if (observed.state.humanGateId) return `run awaits human gate '${observed.state.humanGateId}'`;
  if (observed.state.activeStep) return `run executes step '${observed.state.activeStep}'`;
  return `run is '${observed.state.run.status}' without an active step`;
}

export interface QueryExecutionHistoryInput {
  workItemId?: string;
  limit?: number;
  since?: string;
}

export interface ExecutionSummary {
  runId: string;
  workItemId: string;
  profileId: string;
  attempt: number;
  status: RunStatus;
  phase?: RunPhase;
  sequence: number;
  terminal: boolean;
}

export interface QueryExecutionHistoryResult {
  executions: readonly ExecutionSummary[];
  nextCursor?: string;
}

export async function queryExecutionHistory(
  input: QueryExecutionHistoryInput = {},
  ports: RunEventQueryPort,
): Promise<QueryExecutionHistoryResult> {
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('execution history limit must be an integer between 1 and 100');
  }

  const matching: Array<{ summary: ExecutionSummary; sortKey: string }> = [];
  for (const runId of await ports.listRuns()) {
    const observed = await observeRun(runId, ports);
    if (!observed.state.run || (input.workItemId !== undefined && observed.state.run.workItemId !== input.workItemId)) continue;
    matching.push({
      sortKey: observed.events[0]?.occurredAt ?? '',
      summary: {
        runId,
        workItemId: observed.state.run.workItemId,
        profileId: observed.state.run.profileId,
        attempt: observed.state.run.attempt,
        status: observed.state.run.status,
        phase: observed.state.run.phase,
        sequence: observed.state.sequence,
        terminal: observed.state.terminal,
      },
    });
  }

  matching.sort((left, right) => right.sortKey.localeCompare(left.sortKey) || right.summary.runId.localeCompare(left.summary.runId));
  const summaries = matching.map(entry => entry.summary);

  const cursorIndex = input.since === undefined ? -1 : summaries.findIndex(item => item.runId === input.since);
  if (input.since !== undefined && cursorIndex < 0) throw new Error('execution cursor is not in the requested result set');
  const start = cursorIndex + 1;
  const executions = summaries.slice(start, start + limit);
  return {
    executions,
    nextCursor: summaries.length > start + limit ? executions.at(-1)?.runId : undefined,
  };
}
