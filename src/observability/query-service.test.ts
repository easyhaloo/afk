import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationContext } from '@afk/core';
import { explainExecutionRun, listExecutionRuns, loadRunTimeline, loadWorkItemExecution, queryWorkItemExecutions, replayRun } from '@afk/application';
import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store';
import { createExecutionQueryPorts } from './query-service';

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

describe('execution query ports', () => {
  it('pages all work items by start time without suppressing unknown audit streams', async () => {
    const directory = await root();
    const store = new JsonlEventStore({ root: directory });
    for (const [runId, workItemId] of [
      ['run-a', 'github:team/project#158'],
      ['run-m', 'github:other/project#158'],
      ['run-z', 'github:team/project#158'],
    ]) {
      await store.append([{ id: runId, schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z',
        context: { ...context, runId, workItemId }, correlationId: `attempt-${runId}`,
        data: { kind: 'run.requested', run: { id: runId, workItemId, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    }
    const brokenPath = join(directory, `${Buffer.from('run-z').toString('base64url')}.jsonl`);
    const broken = (await fs.readFile(brokenPath, 'utf8')).replace('"pending"', '"running"');
    await fs.writeFile(brokenPath, broken);
    const ports = createExecutionQueryPorts(new JsonlEventStore({ root: directory }));
    const first = await queryWorkItemExecutions({ limit: 1 }, ports);
    expect(first).toMatchObject({ executions: [{ runId: 'run-m', workItemId: 'github:other/project#158', status: 'queued' }], nextCursor: 'run-m' });
    const second = await queryWorkItemExecutions({ limit: 1, since: first.nextCursor }, ports);
    expect(second).toMatchObject({ executions: [{ runId: 'run-a', workItemId: 'github:team/project#158', status: 'queued' }], nextCursor: 'run-a' });
    await expect(queryWorkItemExecutions({ limit: 1, since: second.nextCursor }, ports))
      .resolves.toMatchObject({ executions: [{ runId: 'run-z', workItemId: '', status: 'unknown', diagnostic: 'integrity_mismatch' }] });
  });

  it('bounds unfiltered pages and rejects invalid limits', async () => {
    const ports = createExecutionQueryPorts(new JsonlEventStore({ root: await root() }));
    await expect(queryWorkItemExecutions({ limit: 0 }, ports)).rejects.toThrow('limit');
    await expect(queryWorkItemExecutions({ limit: 101 }, ports)).rejects.toThrow('limit');
  });

  it('pages matching work items before slicing instead of skipping interleaved runs', async () => {
    const store = new JsonlEventStore({ root: await root() });
    for (const [runId, workItemId] of [
      ['run-a', 'github:other/project#158'],
      ['run-b', 'github:team/project#158'],
      ['run-c', 'github:team/project#158'],
    ]) {
      await store.append([{ id: runId, schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z',
        context: { ...context, runId, workItemId }, correlationId: `attempt-${runId}`,
        data: { kind: 'run.requested', run: { id: runId, workItemId, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    }
    const verify = vi.spyOn(store, 'verify');
    const ports = createExecutionQueryPorts(store);
    const first = await queryWorkItemExecutions({ workItemId: 'github:team/project#158', limit: 1 }, ports);
    expect(first).toMatchObject({ executions: [{ runId: 'run-c', executionId: 'attempt-run-c', status: 'queued' }], nextCursor: 'run-c' });
    expect(verify).toHaveBeenCalledTimes(3);
    const second = await queryWorkItemExecutions({ workItemId: 'github:team/project#158', limit: 1, since: first.nextCursor }, ports);
    expect(second).toMatchObject({ executions: [{ runId: 'run-b', executionId: 'attempt-run-b', status: 'queued' }] });
    expect(verify).toHaveBeenCalledTimes(3);
    expect((await loadWorkItemExecution('run-c', ports)).summary).toMatchObject({ runId: 'run-c', workItemId: 'github:team/project#158' });
    await expect(queryWorkItemExecutions({ workItemId: 'github:team/project#158', since: 'run-b', limit: 1 }, ports))
      .resolves.toMatchObject({ executions: [] });
  });

  it('reuses verified summaries across query instances but refreshes appended and changed streams', async () => {
    const directory = await root();
    const store = new JsonlEventStore({ root: directory });
    const append = async (runId: string, workItemId: string, occurredAt: string) => store.append([
      { id: runId, schemaVersion: 1, type: 'run.requested' as const, occurredAt,
        context: { ...context, runId, workItemId }, correlationId: `attempt-${runId}`,
        data: { kind: 'run.requested' as const, run: { id: runId, workItemId, profileId: 'test', attempt: 1, status: 'pending' as const } } },
    ]);
    await append('run-a', 'github:team/project#158', '2026-09-29T00:00:00.000Z');
    await append('run-b', 'github:other/project#158', '2026-09-29T00:00:01.000Z');
    const verify = vi.spyOn(store, 'verify');
    const first = await queryWorkItemExecutions({ limit: 1 }, createExecutionQueryPorts(store));
    expect(first).toMatchObject({ executions: [{ runId: 'run-b' }], nextCursor: 'run-b' });
    expect(verify).toHaveBeenCalledTimes(2);

    const second = await queryWorkItemExecutions({ limit: 1, since: first.nextCursor }, createExecutionQueryPorts(store));
    expect(second).toMatchObject({ executions: [{ runId: 'run-a' }] });
    expect(verify).toHaveBeenCalledTimes(2);

    await store.append([{ id: 'finished', schemaVersion: 1, type: 'run.finished', occurredAt: '2026-09-29T00:00:02.000Z',
      context: { ...context, runId: 'run-a', workItemId: 'github:team/project#158' }, correlationId: 'attempt-run-a',
      data: { kind: 'run.finished', outcome: 'failed' } }]);
    await append('run-c', 'github:team/project#158', '2026-09-29T00:00:03.000Z');
    const third = await queryWorkItemExecutions({ workItemId: 'github:team/project#158', limit: 1 }, createExecutionQueryPorts(store));
    expect(third).toMatchObject({ executions: [{ runId: 'run-c', status: 'queued' }], nextCursor: 'run-c' });
    const fourth = await queryWorkItemExecutions({ workItemId: 'github:team/project#158', limit: 1, since: third.nextCursor }, createExecutionQueryPorts(store));
    expect(fourth).toMatchObject({ executions: [{ runId: 'run-a', status: 'failed' }] });
    expect(verify).toHaveBeenCalledTimes(4);

    const path = join(directory, `${Buffer.from('run-b').toString('base64url')}.jsonl`);
    await fs.writeFile(path, (await fs.readFile(path, 'utf8')).replace('"pending"', '"running"'));
    expect((await queryWorkItemExecutions({ limit: 3 }, createExecutionQueryPorts(store))).executions.at(-1))
      .toMatchObject({ runId: 'run-b', status: 'unknown', diagnostic: 'integrity_mismatch' });
    expect(verify).toHaveBeenCalledTimes(5);
  });

  it('keeps the cursor position stable when a new run arrives ahead of it', async () => {
    const store = new JsonlEventStore({ root: await root() });
    for (const runId of ['run-a', 'run-b']) {
      await store.append([{ id: runId, schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z',
        context: { ...context, runId }, correlationId: runId,
        data: { kind: 'run.requested', run: { id: runId, workItemId: context.workItemId!, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    }
    const first = await queryWorkItemExecutions({ limit: 1 }, createExecutionQueryPorts(store));
    await store.append([{ id: 'run-c', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z',
      context: { ...context, runId: 'run-c' }, correlationId: 'run-c',
      data: { kind: 'run.requested', run: { id: 'run-c', workItemId: context.workItemId!, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    expect(first.nextCursor).toBe('run-b');
    await expect(queryWorkItemExecutions({ limit: 1, since: first.nextCursor }, createExecutionQueryPorts(store)))
      .resolves.toMatchObject({ executions: [{ runId: 'run-a' }] });
    await expect(queryWorkItemExecutions({ workItemId: 'other', since: first.nextCursor }, createExecutionQueryPorts(store)))
      .rejects.toThrow('execution cursor is not in the requested result set');
  });

  it('still serves verified results when the optional query index cannot be written', async () => {
    const directory = await root();
    const store = new JsonlEventStore({ root: directory });
    await store.append([{ id: 'one', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z',
      context, correlationId: context.runId,
      data: { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId!, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    const writeFile = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('read-only index'));
    try {
      await expect(queryWorkItemExecutions({}, createExecutionQueryPorts(store))).resolves.toMatchObject({ executions: [{ runId: context.runId, status: 'queued' }] });
    } finally {
      writeFile.mockRestore();
    }
  });

  it('reuses the index after reopening the event store and rebuilds a damaged index', async () => {
    const directory = await root();
    const store = new JsonlEventStore({ root: directory });
    await store.append([{ id: 'one', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z',
      context, correlationId: context.runId,
      data: { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId!, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    await queryWorkItemExecutions({}, createExecutionQueryPorts(store));
    const reopened = new JsonlEventStore({ root: directory });
    const verify = vi.spyOn(reopened, 'verify');
    const ports = createExecutionQueryPorts(reopened);
    await expect(queryWorkItemExecutions({}, ports)).resolves.toMatchObject({ executions: [{ runId: context.runId, status: 'queued' }] });
    expect(verify).not.toHaveBeenCalled();

    await fs.writeFile(join(directory, '.execution-query-index.json'), '{broken');
    await expect(queryWorkItemExecutions({}, ports)).resolves.toMatchObject({ executions: [{ runId: context.runId, status: 'queued' }] });
    expect(verify).toHaveBeenCalledTimes(1);
    await queryWorkItemExecutions({}, ports);
    expect(verify).toHaveBeenCalledTimes(1);

    const indexPath = join(directory, '.execution-query-index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index.entries[0][1].summary.status = 'not_a_status';
    await fs.writeFile(indexPath, JSON.stringify(index));
    await expect(queryWorkItemExecutions({}, ports)).resolves.toMatchObject({ executions: [{ runId: context.runId, status: 'queued' }] });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('keeps valid prefix but marks a corrupt hash unknown after reopening the store', async () => {
    const directory = await root();
    const store = new JsonlEventStore({ root: directory });
    await store.append([
      { id: 'one', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z', context, correlationId: context.runId, data: { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId, profileId: 'test', attempt: 1, status: 'pending' } } },
      { id: 'two', schemaVersion: 1, type: 'run.finished', occurredAt: '2026-09-29T00:00:01.000Z', context, correlationId: context.runId, data: { kind: 'run.finished', outcome: 'succeeded' } },
    ]);
    const file = join(directory, `${Buffer.from(context.runId).toString('base64url')}.jsonl`);
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    lines[1] = lines[1].replace('succeeded', 'failed');
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    const result = await loadWorkItemExecution(context.runId, createExecutionQueryPorts(new JsonlEventStore({ root: directory })));
    expect(result.summary).toMatchObject({ status: 'unknown', diagnostic: 'integrity_mismatch' });
    expect(result.timeline.events.map(event => event.id)).toEqual(['one']);
  });

  it('returns unknown for absent and unparseable streams', async () => {
    const directory = await root();
    const ports = createExecutionQueryPorts(new JsonlEventStore({ root: directory }));
    expect((await loadWorkItemExecution('missing', ports)).summary).toMatchObject({ status: 'unknown', diagnostic: 'missing_stream' });
    await fs.writeFile(join(directory, `${Buffer.from('broken').toString('base64url')}.jsonl`), '{partial');
    const broken = await loadWorkItemExecution('broken', ports);
    expect(broken.summary.status).toBe('unknown');
    expect(broken.summary.diagnostic).toContain('cannot parse event');
  });

  it('rejects unbounded pagination and empty identity', async () => {
    const ports = createExecutionQueryPorts(new JsonlEventStore({ root: await root() }));
    await expect(queryWorkItemExecutions({ workItemId: '', limit: 1 }, ports)).rejects.toThrow('workItemId');
    await expect(queryWorkItemExecutions({ workItemId: 'github:team/project#158', limit: 101 }, ports)).rejects.toThrow('limit');
  });

  it('replays a complete event timeline and explains its terminal status', async () => {
    const store = new JsonlEventStore({ root: await root() });
    await store.append([
      { id: 'one', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-08-23T00:00:00.000Z', context, correlationId: context.runId, data: { kind: 'run.requested', run: { id: context.runId, workItemId: '42', profileId: 'test', attempt: 1, status: 'pending' } } },
      { id: 'two', schemaVersion: 1, type: 'run.started', occurredAt: '2026-08-23T00:00:01.000Z', context, correlationId: context.runId, data: { kind: 'run.started' } },
      { id: 'three', schemaVersion: 1, type: 'run.finished', occurredAt: '2026-08-23T00:00:02.000Z', context, correlationId: context.runId, data: { kind: 'run.finished', outcome: 'succeeded' } },
    ]);
    const ports = createExecutionQueryPorts(store);

    await expect(explainExecutionRun(context.runId, ports.events)).resolves.toBe("run finished with status 'succeeded'");
    await expect(replayRun(context.runId, ports.events)).resolves.toMatchObject({
      state: { terminal: true, run: { status: 'succeeded' } },
      timeline: { integrity: { valid: true } },
    });
    await expect(listExecutionRuns(ports.events)).resolves.toEqual([context.runId]);
    expect((await loadRunTimeline(context.runId, ports.events)).events.map(event => event.id)).toEqual(['one', 'two', 'three']);
  });
});
