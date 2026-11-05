import type { RunEvent, RunPhase, RunStatus } from '@afk/core';
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
  startedAt?: string;
  usage?: AgentUsage;
  /** The root cause of the failure, when the run failed. */
  failureSummary?: string;
  /** The machine-readable failure code, when the run failed. */
  failureCode?: string;
}

/**
 * The root cause of a run, as its event stream recorded it.
 *
 * A failure is classified once, in a `failure.classified` event. Later events
 * do not repeat it, so the summary has to look it up — otherwise a failed
 * execution is listed without any reason at all.
 */
export function rootFailureOf(events: readonly RunEvent[]): { summary?: string; code?: string } {
  for (let index = events.length - 1; index >= 0; index--) {
    const data = events[index].data;
    if (data.kind === 'failure.classified') {
      let root: { summary: string; code?: string } = {
        summary: data.summary,
        ...(data.code ? { code: data.code } : {}),
      };
      let node = data.cause;
      while (node) {
        root = { summary: node.message, code: node.code };
        node = node.cause;
      }
      return root;
    }
    if (data.kind === 'qa.failed') {
      const summary = data.summary ?? data.reason;
      if (summary) return { summary, ...(data.reasonCode ? { code: data.reasonCode } : {}) };
    }
  }
  return {};
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
    if (!observed.integrity.valid || !observed.state.run || (input.workItemId !== undefined && observed.state.run.workItemId !== input.workItemId)) continue;
    const usage = observed.integrity.valid ? projectAgentUsage(observed.events.filter(event =>
      event.sequence <= observed.integrity.lastSequence && event.context.workItemId === observed.state.run!.workItemId
      && event.correlationId === observed.events[0]?.correlationId)) : undefined;
    const startedAt = observed.integrity.valid ? observed.events.find(event =>
      event.data.kind === 'run.started' && event.sequence <= observed.integrity.lastSequence
      && event.context.runId === runId && event.context.workItemId === observed.state.run!.workItemId
      && event.correlationId === observed.events[0]?.correlationId)?.occurredAt : undefined;
    const failure = observed.state.run.status === 'failed'
      ? rootFailureOf(observed.events.filter(event => event.sequence <= observed.integrity.lastSequence))
      : {};
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
        ...(startedAt ? { startedAt } : {}),
        ...(usage ? { usage } : {}),
        ...(failure.summary ? { failureSummary: failure.summary } : {}),
        ...(failure.code ? { failureCode: failure.code } : {}),
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
