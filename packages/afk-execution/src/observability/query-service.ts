import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { isAgentUsage, loadWorkItemExecution, type ExecutionQueryPorts, type WorkItemExecutionSummary } from '@afk/application';
import type { EventStorePort } from '@afk/core';
import { projectWorkItemExecution } from './work-item-execution-projection.js';

interface IndexedExecution {
  signature: string;
  summary: WorkItemExecutionSummary;
}

const indexName = '.execution-query-index.json';
const indexVersion = 2;
const executionStatuses = new Set<WorkItemExecutionSummary['status']>([
  'queued', 'implementing', 'verifying', 'publishing', 'awaiting_merge', 'rework', 'blocked', 'failed', 'done', 'unknown',
]);

export function createExecutionQueryPorts(events: EventStorePort): ExecutionQueryPorts {
  const projection = { project: projectWorkItemExecution };
  return {
    events,
    projection,
    summaries: { list: () => listIndexedExecutionSummaries(events, projection) },
  };
}

async function listIndexedExecutionSummaries(
  events: EventStorePort,
  projection: ExecutionQueryPorts['projection'],
): Promise<readonly WorkItemExecutionSummary[]> {
  // The store says where a reader may keep its cache and what it holds for
  // each run. A reader that guessed the store's layout would silently keep
  // no cache against every store but one.
  const directory = events.cacheDirectory?.();
  const previous = directory ? await readIndex(join(directory, indexName)) : new Map<string, IndexedExecution>();
  const current = new Map<string, IndexedExecution>();
  const summaries: WorkItemExecutionSummary[] = [];
  let changed = false;
  for (const runId of await events.listRuns()) {
    const signature = events.revision ? await events.revision(runId) : undefined;
    const cached = signature === undefined ? undefined : previous.get(runId);
    let summary: WorkItemExecutionSummary;
    if (cached && cached.signature === signature) {
      summary = cached.summary;
    } else {
      summary = (await loadWorkItemExecution(runId, { events, projection })).summary;
      changed = true;
    }
    if (signature !== undefined) current.set(runId, { signature, summary });
    summaries.push(summary);
  }
  if (directory && (changed || previous.size !== current.size)) await writeIndex(join(directory, indexName), current).catch(() => undefined);
  return summaries;
}

async function readIndex(path: string): Promise<Map<string, IndexedExecution>> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== indexVersion || !('entries' in data) || !Array.isArray(data.entries)) return new Map();
    const entries = data.entries as unknown[];
    if (!entries.every((entry): entry is [string, IndexedExecution] => Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === 'string' && !!entry[1] && typeof entry[1] === 'object'
      && typeof entry[1].signature === 'string' && !!entry[1].summary && typeof entry[1].summary === 'object'
      && entry[1].summary.runId === entry[0] && typeof entry[1].summary.workItemId === 'string'
      && typeof entry[1].summary.executionId === 'string' && executionStatuses.has(entry[1].summary.status)
      && (entry[1].summary.startedAt === undefined || typeof entry[1].summary.startedAt === 'string')
      && (entry[1].summary.updatedAt === undefined || typeof entry[1].summary.updatedAt === 'string')
      && (entry[1].summary.diagnostic === undefined || typeof entry[1].summary.diagnostic === 'string')
      && (entry[1].summary.usage === undefined || isAgentUsage(entry[1].summary.usage))
      && (entry[1].summary.pr === undefined || (typeof entry[1].summary.pr?.id === 'string'
        && typeof entry[1].summary.pr?.url === 'string' && ['open', 'merged'].includes(entry[1].summary.pr?.state))))) return new Map();
    return new Map(entries);
  } catch {
    return new Map();
  }
}

async function writeIndex(path: string, entries: Map<string, IndexedExecution>): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: indexVersion, entries: [...entries] }), { mode: 0o600 });
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
