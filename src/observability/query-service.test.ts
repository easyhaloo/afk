import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationContext } from '../core/events';
import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store';
import { RunQueryService } from './query-service';

const roots: string[] = [];
const context: ObservationContext = {
  traceId: 'trace-1', runId: 'run-1', workItemId: '42', profileId: 'test', attempt: 1,
  actor: { kind: 'system', id: 'test' },
};

async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'afk-query-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe('RunQueryService', () => {
  it('replays a complete event timeline and explains its terminal status', async () => {
    const store = new JsonlEventStore({ root: await root() });
    await store.append([
      { id: 'one', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-08-23T00:00:00.000Z', context, correlationId: context.runId, data: { kind: 'run.requested', run: { id: context.runId, workItemId: '42', profileId: 'test', attempt: 1, status: 'pending' } } },
      { id: 'two', schemaVersion: 1, type: 'run.started', occurredAt: '2026-08-23T00:00:01.000Z', context, correlationId: context.runId, data: { kind: 'run.started' } },
      { id: 'three', schemaVersion: 1, type: 'run.finished', occurredAt: '2026-08-23T00:00:02.000Z', context, correlationId: context.runId, data: { kind: 'run.finished', outcome: 'succeeded' } },
    ]);
    const queries = new RunQueryService(store);

    await expect(queries.explain(context.runId)).resolves.toBe("run finished with status 'succeeded'");
    await expect(queries.replay(context.runId)).resolves.toMatchObject({
      state: { terminal: true, run: { status: 'succeeded' } },
      timeline: { integrity: { valid: true } },
    });
  });
});
