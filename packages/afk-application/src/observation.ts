import type { RunPhase, RunStatus } from '@afk/core';
import { loadRun } from './execution.js';
import { projectAgentUsage, type AgentUsage } from './execution-query.js';
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
    integrity: loaded.integrity,
  };
}

export async function listRunIds(ports: RunEventQueryPort): Promise<readonly string[]> {
  return ports.listRuns();
}

/**
 * The workspace a run was prepared in, read from the event that prepared it.
 *
 * The run's own detail already reads this event, so the run centre's detail
 * knew the path while its list did not — and the list is what the board
 * shows. The path is a fact about the run, so it belongs in the summary.
 */
function preparedWorkspace(
  events: Awaited<ReturnType<typeof loadRun>>['events'],
): { path: string; branch: string } | undefined {
  for (const event of events) {
    if (event.data.kind !== 'workspace.prepared') continue;
    return { path: event.data.workspace, branch: event.data.branch };
  }
  return undefined;
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
  /** When the run was first recorded, and when its last event was. */
  startedAt?: string;
  updatedAt?: string;
  /** False when the run's event chain is broken; the summary then describes
   *  only the prefix the chain vouches for. */
  integrityValid: boolean;
  /** The workspace the run was prepared in, when the run recorded one. */
  workspacePath?: string;
  /** The branch the run worked on, when the run recorded one. */
  workspaceBranch?: string;
  usage?: AgentUsage;
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
    let observed: Awaited<ReturnType<typeof observeRun>>;
    try {
      observed = await observeRun(runId, ports);
    } catch {
      continue;
    }
    if (!observed.state.run || (input.workItemId !== undefined && observed.state.run.workItemId !== input.workItemId)) continue;
    const usage = observed.integrity.valid ? projectAgentUsage(observed.events.filter(event =>
      event.sequence <= observed.integrity.lastSequence && event.context.workItemId === observed.state.run!.workItemId
      && event.correlationId === observed.events[0]?.correlationId)) : undefined;
    const workspace = preparedWorkspace(observed.events);
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
        ...(observed.events[0]?.occurredAt ? { startedAt: observed.events[0].occurredAt } : {}),
        ...(observed.events.at(-1)?.occurredAt ? { updatedAt: observed.events.at(-1)!.occurredAt } : {}),
        integrityValid: observed.integrity.valid,
        ...(workspace ? { workspacePath: workspace.path, workspaceBranch: workspace.branch } : {}),
        ...(usage ? { usage } : {}),
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
