import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationContext, RunEventDraft } from '@afk/core';
import { JsonlEventStore } from '../src/observability/jsonl-event-store.js';

const roots: string[] = [];
const context: ObservationContext = {
  traceId: 'trace-1',
  runId: 'run-1',
  workItemId: '42',
  profileId: 'test',
  attempt: 1,
  actor: { kind: 'system', id: 'test' },
};

async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'afk-events-'));
  roots.push(path);
  return path;
}

function draft(id: string, kind: 'run.requested' | 'run.started', observation: ObservationContext = context): RunEventDraft {
  return {
    id,
    schemaVersion: 1,
    type: kind,
    occurredAt: '2026-08-23T00:00:00.000Z',
    context: observation,
    correlationId: observation.runId,
    data: kind === 'run.requested'
      ? { kind, run: { id: observation.runId, workItemId: observation.workItemId, profileId: observation.profileId, attempt: 1, status: 'pending' } }
      : { kind },
  };
}

function finished(runId: string, occurredAt: string, outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): RunEventDraft {
  return {
    ...draft(`${runId}-finished`, 'run.started', { ...context, runId }),
    type: 'run.finished',
    occurredAt,
    data: { kind: 'run.finished', outcome },
  };
}

async function terminal(store: JsonlEventStore, runId: string, occurredAt: string, outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): Promise<void> {
  const observation = { ...context, runId };
  await store.append([
    draft(`${runId}-requested`, 'run.requested', observation),
    draft(`${runId}-started`, 'run.started', observation),
    finished(runId, occurredAt, outcome),
  ]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe('JsonlEventStore', () => {
  it('resolves its root the same way for every entry point', () => {
    const previous = process.env.AFK_EVENT_STORE_DIR;
    try {
      process.env.AFK_EVENT_STORE_DIR = join(tmpdir(), 'custom-events');
      expect(new JsonlEventStore().root).toBe(join(tmpdir(), 'custom-events'));
      // An explicit root still wins.
      expect(new JsonlEventStore({ root: join(tmpdir(), 'explicit') }).root).toBe(join(tmpdir(), 'explicit'));
    } finally {
      if (previous === undefined) delete process.env.AFK_EVENT_STORE_DIR;
      else process.env.AFK_EVENT_STORE_DIR = previous;
    }
  });

  it('retains history by default and prunes only terminal runs strictly older than the event-time cutoff', async () => {
    const store = new JsonlEventStore({ root: await root(), now: () => new Date('2026-10-13T00:00:00.000Z') });
    const retentionMs = 24 * 60 * 60 * 1000;
    for (const outcome of ['succeeded', 'failed', 'cancelled'] as const) {
      await terminal(store, outcome, '2026-10-11T23:59:59.999Z', outcome);
    }
    await terminal(store, 'boundary', '2026-10-12T00:00:00.000Z');
    await terminal(store, 'recent', '2026-10-12T00:00:00.001Z');
    await fs.utimes(join(store.root, `${Buffer.from('recent').toString('base64url')}.jsonl`), 0, 0);
    const history = await store.listRuns();
    await expect(store.prune()).resolves.toEqual([]);
    await expect(store.prune({ retentionMs })).resolves.toEqual([]);
    await expect(store.prune({ exclusiveAccess: true })).resolves.toEqual([]);
    await expect(new JsonlEventStore({ root: store.root }).listRuns()).resolves.toEqual(history);

    const indexPath = join(store.root, '.execution-query-index.json');
    const budgetPath = join(store.root, '.afk', 'budgets', '42.json');
    await fs.writeFile(indexPath, 'index cache');
    await fs.mkdir(join(store.root, '.afk', 'budgets'), { recursive: true });
    await fs.writeFile(budgetPath, 'budget ledger');

    await expect(store.prune({ retentionMs, exclusiveAccess: true })).resolves.toEqual(['cancelled', 'failed', 'succeeded']);
    await expect(store.listRuns()).resolves.toEqual(['boundary', 'recent']);
    await expect(fs.readFile(indexPath, 'utf8')).resolves.toBe('index cache');
    await expect(fs.readFile(budgetPath, 'utf8')).resolves.toBe('budget ledger');
  });

  it('retains active, awaiting-human, corrupt and unknown streams even when they are old', async () => {
    const store = new JsonlEventStore({ root: await root(), now: () => new Date('2026-10-13T00:00:00.000Z') });
    const old = '2026-08-23T00:00:00.000Z';
    for (const runId of ['pending', 'active', 'awaiting', 'unknown-schema', 'unknown-type', 'invalid-time', 'non-string-time', 'invalid-outcome', 'mismatch', 'newer-event', 'unfinished', 'tampered', 'sequence-gap', 'run-mismatch', 'truncated']) {
      const observation = { ...context, runId };
      const requested = draft(`${runId}-requested`, 'run.requested', observation);
      const started = draft(`${runId}-started`, 'run.started', observation);
      const end = finished(runId, old);
      let events: readonly RunEventDraft[] = [requested, started, end];
      if (runId === 'pending') events = [requested];
      if (runId === 'active') events = [requested, started];
      if (runId === 'awaiting') events = [requested, started, { ...started, type: 'human_gate.opened', data: { kind: 'human_gate.opened', gateId: 'gate', reason: 'review' } }];
      if (runId === 'unknown-schema') events = [requested, started, { ...end, schemaVersion: 2 } as unknown as RunEventDraft];
      if (runId === 'unknown-type') events = [requested, { ...started, type: 'future.event', data: { kind: 'future.event' } } as unknown as RunEventDraft, end];
      if (runId === 'invalid-time') events = [requested, started, { ...end, occurredAt: 'not-a-date' }];
      if (runId === 'non-string-time') events = [requested, started, { ...end, occurredAt: 0 } as unknown as RunEventDraft];
      if (runId === 'invalid-outcome') events = [requested, started, { ...end, data: { kind: 'run.finished', outcome: 'awaiting_human' } } as unknown as RunEventDraft];
      if (runId === 'mismatch') events = [requested, started, { ...end, type: 'run.started' } as RunEventDraft];
      if (runId === 'newer-event') events = [requested, { ...started, occurredAt: '2026-10-12T00:00:01.000Z' }, end];
      if (runId === 'unfinished') events = [requested, started, end, started];
      await store.append(events);
      const file = join(store.root, `${Buffer.from(runId).toString('base64url')}.jsonl`);
      if (runId === 'tampered') await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('succeeded', 'failed'));
      if (runId === 'sequence-gap') await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"sequence":2', '"sequence":3'));
      if (runId === 'run-mismatch') await fs.copyFile(join(store.root, `${Buffer.from('active').toString('base64url')}.jsonl`), file);
      if (runId === 'truncated') await fs.appendFile(file, '{"incomplete":');
    }
    await fs.writeFile(join(store.root, `${Buffer.from('empty').toString('base64url')}.jsonl`), '');
    await fs.writeFile(join(store.root, 'unknown.jsonl'), 'unrecognized log');
    const before = await store.listRuns();
    await expect(store.prune({ retentionMs: 24 * 60 * 60 * 1000, exclusiveAccess: true })).resolves.toEqual([]);
    await expect(store.listRuns()).resolves.toEqual(before);
  });

  it.each(['ahead of pruning', 'during verification'])('retains a run when an append is queued %s', async timing => {
    const store = new JsonlEventStore({ root: await root(), now: () => new Date('2026-10-13T00:00:00.000Z') });
    await terminal(store, context.runId, '2026-08-23T00:00:00.000Z');
    const listRuns = store.listRuns.bind(store);
    let append: Promise<unknown> | undefined;
    if (timing === 'ahead of pruning') {
      vi.spyOn(store, 'listRuns').mockImplementation(async () => {
        const runIds = await listRuns();
        queueMicrotask(() => { append = store.append([draft('late', 'run.started')]); });
        return runIds;
      });
    } else {
      const verify = store.verify.bind(store);
      vi.spyOn(store, 'verify').mockImplementation(async runId => {
        const result = await verify(runId);
        append = store.append([draft('late', 'run.started')]);
        return result;
      });
    }
    await expect(store.prune({ retentionMs: 0, exclusiveAccess: true })).resolves.toEqual([]);
    await append;
    const events = [];
    for await (const event of store.read(context.runId)) events.push(event);
    expect(events.map(event => event.id)).toEqual(['run-1-requested', 'run-1-started', 'run-1-finished', 'late']);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    await expect(new JsonlEventStore({ root: store.root }).verify(context.runId)).resolves.toMatchObject({ valid: true, lastSequence: 4 });
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid retentionMs %s without deleting history', async retentionMs => {
    const store = new JsonlEventStore({ root: await root() });
    await terminal(store, context.runId, '2026-08-23T00:00:00.000Z');
    await expect(store.prune({ retentionMs, exclusiveAccess: true })).rejects.toThrow('retentionMs');
    await expect(store.listRuns()).resolves.toEqual([context.runId]);
  });

  it('assigns ordered sequences, hash chains, and survives a fresh store instance', async () => {
    const path = await root();
    const store = new JsonlEventStore({ root: path, now: () => new Date('2026-08-23T00:00:01.000Z') });
    const receipt = await store.append([draft('one', 'run.requested'), draft('two', 'run.started')]);

    expect(receipt).toMatchObject({ runId: context.runId, firstSequence: 1, lastSequence: 2 });
    const events = [];
    for await (const event of new JsonlEventStore({ root: path }).read(context.runId)) events.push(event);
    expect(events.map(event => event.sequence)).toEqual([1, 2]);
    expect(events[1].integrity.prevHash).toBe(events[0].integrity.hash);
    await expect(store.verify(context.runId)).resolves.toMatchObject({ valid: true, lastSequence: 2 });
  });

  it('lists no runs for a missing directory and discovers multiple encoded run IDs', async () => {
    const path = await root();
    const store = new JsonlEventStore({ root: path });
    await expect(store.listRuns()).resolves.toEqual([]);

    await store.append([draft('one', 'run.requested')]);
    const secondContext = { ...context, runId: 'run-2' };
    await store.append([draft('two', 'run.requested', secondContext)]);

    await expect(store.listRuns()).resolves.toEqual(['run-1', 'run-2']);
  });

  it('detects tampered payloads during verification', async () => {
    const path = await root();
    const store = new JsonlEventStore({ root: path });
    await store.append([draft('one', 'run.requested')]);
    const file = join(path, `${Buffer.from(context.runId).toString('base64url')}.jsonl`);
    const tampered = (await fs.readFile(file, 'utf8')).replace('run.requested', 'run.started');
    await fs.writeFile(file, tampered, 'utf8');

    await expect(store.verify(context.runId)).resolves.toMatchObject({ valid: false, reason: 'integrity_mismatch' });
  });

  it('hashes nested event values independently of object key insertion order', async () => {
    const firstRoot = await root();
    const secondRoot = await root();
    const first = draft('one', 'run.requested');
    const second: RunEventDraft = {
      ...first,
      data: {
        kind: 'run.requested',
        run: { status: 'pending', attempt: 1, profileId: 'test', workItemId: '42', id: 'run-1' },
      },
    };

    const firstStore = new JsonlEventStore({ root: firstRoot, now: () => new Date('2026-08-23T00:00:01.000Z') });
    const secondStore = new JsonlEventStore({ root: secondRoot, now: () => new Date('2026-08-23T00:00:01.000Z') });
    const firstReceipt = await firstStore.append([first]);
    const secondReceipt = await secondStore.append([second]);

    expect(firstReceipt.lastHash).toBe(secondReceipt.lastHash);
    await expect(firstStore.verify(context.runId)).resolves.toMatchObject({ valid: true });
    await expect(secondStore.verify(context.runId)).resolves.toMatchObject({ valid: true });
  });

  it('verifies event hashes after JSON serialization omits optional undefined fields', async () => {
    const store = new JsonlEventStore({ root: await root() });
    await store.append([{ ...draft('optional', 'run.requested'), causationId: undefined, idempotencyKey: undefined, evidence: undefined }]);
    await expect(new JsonlEventStore({ root: store.root }).verify(context.runId)).resolves.toMatchObject({ valid: true, lastSequence: 1 });
  });
});
