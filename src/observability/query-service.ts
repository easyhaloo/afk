import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { replay } from '../core/reducer';
import type { RunAggregate } from '../core/model';
import type { RunEvent } from '../core/events';
import type { EventStorePort } from '../core/ports';
import { projectWorkItemExecution, type ExecutionSummary, type WorkItemExecution } from './work-item-execution-projection';

export interface RunTimeline {
  runId: string;
  events: readonly RunEvent[];
  integrity: Awaited<ReturnType<EventStorePort['verify']>>;
}

interface IndexedExecution {
  signature: string;
  summary: ExecutionSummary;
}

const indexName = '.execution-query-index.json';
const executionStatuses = new Set<ExecutionSummary['status']>([
  'queued', 'implementing', 'verifying', 'publishing', 'awaiting_merge', 'rework', 'blocked', 'failed', 'done', 'unknown',
]);

export class RunQueryService {
  constructor(private readonly events: EventStorePort) {}

  async runs(): Promise<readonly string[]> {
    return this.events.listRuns();
  }

  async timeline(runId: string): Promise<RunTimeline> {
    const events: RunEvent[] = [];
    for await (const event of this.events.read(runId)) events.push(event);
    return { runId, events, integrity: await this.events.verify(runId) };
  }

  async execution(runId: string): Promise<WorkItemExecution> {
    if (!runId) throw new Error('runId is required');
    const integrity = await this.events.verify(runId);
    const events: RunEvent[] = [];
    try {
      for await (const event of this.events.read(runId)) events.push(event);
    } catch (error) {
      return projectWorkItemExecution({ runId, events, integrity: {
        ...integrity, valid: false,
        reason: error instanceof Error ? error.message : 'unreadable_stream',
      } });
    }
    return projectWorkItemExecution({ runId, events, integrity });
  }

  async workItemExecutions(options: { workItemId: string; limit?: number; since?: string }): Promise<{ executions: readonly ExecutionSummary[]; nextCursor?: string }> {
    if (!options.workItemId) throw new Error('workItemId is required');
    return this.pageExecutions(options);
  }

  async recentExecutions(options: { limit?: number; since?: string } = {}): Promise<{ executions: readonly ExecutionSummary[]; nextCursor?: string }> {
    return this.pageExecutions(options);
  }

  private async pageExecutions(options: { workItemId?: string; limit?: number; since?: string }): Promise<{ executions: readonly ExecutionSummary[]; nextCursor?: string }> {
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100');
    const executions: ExecutionSummary[] = [];
    const root = (this.events as EventStorePort & { root?: unknown }).root;
    const directory = typeof root === 'string' ? root : undefined;
    const previous = directory ? await this.readIndex(join(directory, indexName)) : new Map<string, IndexedExecution>();
    const current = new Map<string, IndexedExecution>();
    let changed = false;
    for (const runId of await this.events.listRuns()) {
      const signature = directory ? await this.signature(join(directory, `${Buffer.from(runId, 'utf8').toString('base64url')}.jsonl`)) : undefined;
      const cached = signature === undefined ? undefined : previous.get(runId);
      let summary: ExecutionSummary;
      if (cached && cached.signature === signature) {
        summary = cached.summary;
      } else {
        summary = (await this.execution(runId)).summary;
        changed = true;
      }
      if (signature !== undefined) current.set(runId, { signature, summary });
      if (options.workItemId === undefined || summary.workItemId === options.workItemId) executions.push(summary);
    }
    if (directory && (changed || previous.size !== current.size)) await this.writeIndex(join(directory, indexName), current).catch(() => undefined);
    executions.sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? '') || right.runId.localeCompare(left.runId));
    const cursorIndex = options.since === undefined ? -1 : executions.findIndex(item => item.runId === options.since);
    if (options.since !== undefined && cursorIndex < 0) throw new Error('execution cursor is not in the requested result set');
    const start = cursorIndex + 1;
    const page = executions.slice(start, start + limit);
    return { executions: page, nextCursor: executions.length > start + limit ? page.at(-1)?.runId : undefined };
  }

  private async signature(path: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(path);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
      return undefined;
    }
  }

  private async readIndex(path: string): Promise<Map<string, IndexedExecution>> {
    try {
      const data: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('entries' in data) || !Array.isArray(data.entries)) return new Map();
      const entries = data.entries as unknown[];
      if (!entries.every((entry): entry is [string, IndexedExecution] => Array.isArray(entry) && entry.length === 2
        && typeof entry[0] === 'string' && !!entry[1] && typeof entry[1] === 'object'
        && typeof entry[1].signature === 'string' && !!entry[1].summary && typeof entry[1].summary === 'object'
        && entry[1].summary.runId === entry[0] && typeof entry[1].summary.workItemId === 'string'
        && typeof entry[1].summary.executionId === 'string' && executionStatuses.has(entry[1].summary.status)
        && (entry[1].summary.startedAt === undefined || typeof entry[1].summary.startedAt === 'string')
        && (entry[1].summary.updatedAt === undefined || typeof entry[1].summary.updatedAt === 'string')
        && (entry[1].summary.diagnostic === undefined || typeof entry[1].summary.diagnostic === 'string')
        && (entry[1].summary.pr === undefined || (typeof entry[1].summary.pr?.id === 'string'
          && typeof entry[1].summary.pr?.url === 'string' && ['open', 'merged'].includes(entry[1].summary.pr?.state))))) return new Map();
      return new Map(entries);
    } catch (error) {
      return new Map();
    }
  }

  private async writeIndex(path: string, entries: Map<string, IndexedExecution>): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: [...entries] }), { mode: 0o600 });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async replay(runId: string): Promise<{ timeline: RunTimeline; state?: RunAggregate; explanation?: string }> {
    const timeline = await this.timeline(runId);
    if (!timeline.integrity.valid) return { timeline, explanation: `cannot replay invalid event stream: ${timeline.integrity.reason ?? 'unknown'}` };
    try {
      return { timeline, state: replay(timeline.events) };
    } catch (error) {
      return { timeline, explanation: error instanceof Error ? error.message : String(error) };
    }
  }

  async explain(runId: string): Promise<string> {
    const result = await this.replay(runId);
    if (result.explanation) return result.explanation;
    if (!result.state?.run) return 'no events recorded for this run';
    if (result.state.terminal) return `run finished with status '${result.state.run.status}'`;
    if (result.state.humanGateId) return `run awaits human gate '${result.state.humanGateId}'`;
    if (result.state.activeStep) return `run executes step '${result.state.activeStep}'`;
    return `run is '${result.state.run.status}' without an active step`;
  }
}
