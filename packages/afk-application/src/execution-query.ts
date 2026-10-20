import { replay, type RunAggregate, type RunEvent, type RunEventData } from '@afk/core';
import { readVerifiedEvents } from './execution.js';
import type { RunEventQueryPort } from './ports.js';

export interface ExecutionTimeline {
  runId: string;
  events: readonly RunEvent[];
  integrity: Awaited<ReturnType<RunEventQueryPort['verify']>>;
}

export type WorkItemExecutionStatus = 'queued' | 'implementing' | 'verifying' | 'publishing' | 'awaiting_merge' | 'rework' | 'blocked' | 'failed' | 'done' | 'unknown';

export type AgentUsage = NonNullable<Extract<RunEventData, { kind: 'agent.session_recorded' }>['usage']>;

export function isAgentUsage(input: unknown): input is AgentUsage {
  if (!input || typeof input !== 'object') return false;
  const usage = input as AgentUsage;
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)
    && usage.totalTokens === usage.inputTokens + usage.outputTokens;
}

export function projectAgentUsage(events: readonly RunEvent[]): AgentUsage | undefined {
  const sessions = new Map<string, AgentUsage>();
  for (const event of events) {
    if (event.data.kind === 'agent.session_recorded' && event.data.sessionId && isAgentUsage(event.data.usage)) {
      const previous = sessions.get(event.data.sessionId);
      if (!previous || event.data.usage.totalTokens >= previous.totalTokens) sessions.set(event.data.sessionId, event.data.usage);
    }
  }
  if (!sessions.size) return undefined;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const session of sessions.values()) {
    usage.inputTokens += session.inputTokens;
    usage.outputTokens += session.outputTokens;
    usage.totalTokens += session.totalTokens;
  }
  return isAgentUsage(usage) ? usage : undefined;
}

export interface WorkItemExecutionSummary {
  executionId: string;
  runId: string;
  workItemId: string;
  status: WorkItemExecutionStatus;
  startedAt?: string;
  updatedAt?: string;
  diagnostic?: string;
  pr?: { id: string; url: string; state: 'open' | 'merged' };
  usage?: AgentUsage;
}

export interface WorkItemExecution {
  summary: WorkItemExecutionSummary;
  timeline: ExecutionTimeline;
}

export interface ExecutionProjectionPort {
  project(timeline: ExecutionTimeline): WorkItemExecution;
}

export interface ExecutionSummaryQueryPort {
  list(): Promise<readonly WorkItemExecutionSummary[]>;
}

export interface ExecutionQueryPorts {
  events: RunEventQueryPort;
  projection: ExecutionProjectionPort;
  summaries: ExecutionSummaryQueryPort;
}

export async function listExecutionRuns(events: RunEventQueryPort): Promise<readonly string[]> {
  return events.listRuns();
}

export async function loadRunTimeline(runId: string, events: RunEventQueryPort): Promise<ExecutionTimeline> {
  const verified = await readVerifiedEvents(runId, events);
  return { runId, events: verified.events, integrity: verified.integrity };
}

export async function loadWorkItemExecution(
  runId: string,
  ports: Pick<ExecutionQueryPorts, 'events' | 'projection'>,
): Promise<WorkItemExecution> {
  if (!runId) throw new Error('runId is required');
  const integrity = await ports.events.verify(runId);
  const recorded: RunEvent[] = [];
  try {
    for await (const event of ports.events.read(runId)) recorded.push(event);
  } catch (error) {
    return ports.projection.project({ runId, events: recorded, integrity: {
      ...integrity, valid: false, reason: error instanceof Error ? error.message : 'unreadable_stream',
    } });
  }
  // Only the prefix the chain vouches for reaches the projection.
  const verified = recorded.filter(event => event.sequence <= integrity.lastSequence);
  return ports.projection.project({ runId, events: verified, integrity });
}

export async function queryWorkItemExecutions(
  options: { workItemId?: string; limit?: number; since?: string },
  ports: Pick<ExecutionQueryPorts, 'summaries'>,
): Promise<{ executions: readonly WorkItemExecutionSummary[]; nextCursor?: string }> {
  if (options.workItemId === '') throw new Error('workItemId is required');
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100');
  const executions = (await ports.summaries.list())
    .filter(summary => options.workItemId === undefined || summary.workItemId === options.workItemId)
    .sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? '') || right.runId.localeCompare(left.runId));
  const cursorIndex = options.since === undefined ? -1 : executions.findIndex(summary => summary.runId === options.since);
  if (options.since !== undefined && cursorIndex < 0) throw new Error('execution cursor is not in the requested result set');
  const start = cursorIndex + 1;
  const page = executions.slice(start, start + limit);
  return { executions: page, nextCursor: executions.length > start + limit ? page.at(-1)?.runId : undefined };
}

export async function replayRun(runId: string, events: RunEventQueryPort): Promise<{
  timeline: ExecutionTimeline; state?: RunAggregate; explanation?: string;
}> {
  const timeline = await loadRunTimeline(runId, events);
  if (!timeline.integrity.valid) return { timeline, state: undefined, explanation: `cannot replay invalid event stream: ${timeline.integrity.reason ?? 'unknown'}` };
  try {
    return { timeline, state: replay(timeline.events) };
  } catch (error) {
    return { timeline, explanation: error instanceof Error ? error.message : String(error) };
  }
}

export async function explainExecutionRun(runId: string, events: RunEventQueryPort): Promise<string> {
  const result = await replayRun(runId, events);
  if (result.explanation) return result.explanation;
  if (!result.state?.run) return 'no events recorded for this run';
  if (result.state.terminal) return `run finished with status '${result.state.run.status}'`;
  if (result.state.humanGateId) return `run awaits human gate '${result.state.humanGateId}'`;
  if (result.state.activeStep) return `run executes step '${result.state.activeStep}'`;
  return `run is '${result.state.run.status}' without an active step`;
}
