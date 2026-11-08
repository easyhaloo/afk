import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../io/logger.js';
import type { MetricsProvider, TracerProvider, EventStoreProvider } from '../../plugin-sdk/capabilities.js';
import { JsonlEventStore } from './jsonl-event-store.js';
import { createRunObserver } from './run-observer-factory.js';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const context = {
  traceId: 'trace-1', runId: 'run-1', workItemId: 'github:org/repo#1',
  profileId: 'test', attempt: 1, actor: { kind: 'cli' as const, id: 'test' },
};

async function directory() {
  const root = await fs.mkdtemp(join(tmpdir(), 'observer-plugin-'));
  roots.push(root);
  return root;
}

function provider() {
  return {
    id: 'capture',
    capabilities: { span: true, event: true, baggage: false, counter: true, gauge: true, histogram: true },
    startSpan: vi.fn<TracerProvider['startSpan']>(async () => undefined),
    addEvent: vi.fn<TracerProvider['addEvent']>(async () => undefined),
    endSpan: vi.fn<NonNullable<TracerProvider['endSpan']>>(async () => undefined),
    record: vi.fn<MetricsProvider['record']>(async () => undefined),
  };
}

describe('observability exporters', () => {
  it('awaits spans and low-cardinality metrics without duplicating a shared provider', async () => {
    const capture = provider();
    const selection = { provider: capture, signals: ['tracing', 'metrics'] as const };
    const observer = createRunObserver(await directory(), [selection, selection]);
    await observer.record(context, { kind: 'run.started' });
    const trace = capture.startSpan.mock.calls[0][1];
    expect(trace).toMatchObject({ traceId: context.traceId, spanId: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(capture.startSpan).toHaveBeenCalledTimes(1);
    expect(capture.startSpan.mock.calls[0][2]?.attributes).toMatchObject({ run_id: context.runId, work_item_id: context.workItemId });
    expect(capture.addEvent).toHaveBeenCalledWith(trace, 'run.started', expect.objectContaining({ attributes: { event_sequence: 1 } }));
    expect(capture.endSpan).toHaveBeenCalledWith(trace, expect.objectContaining({ error: false }));
    expect(capture.record.mock.calls.map(([sample]) => sample)).toEqual([
      { name: 'afk.run_events_total', value: 1, kind: 'counter', attributes: { event_type: 'run.started', profile_id: 'test', actor_kind: 'cli' } },
      { name: 'run.event_persistence_ms', value: expect.any(Number), kind: 'histogram', attributes: { event_type: 'run.started' } },
    ]);
    expect(capture.startSpan.mock.invocationCallOrder[0]).toBeLessThan(capture.addEvent.mock.invocationCallOrder[0]);
    expect(capture.addEvent.mock.invocationCallOrder[0]).toBeLessThan(capture.endSpan.mock.invocationCallOrder[0]);
  });

  it('keeps simultaneous spans and their events isolated', async () => {
    const capture = provider();
    const observer = createRunObserver(await directory(), [{ provider: capture, signals: ['tracing', 'metrics'] }]);
    await Promise.all([
      observer.record({ ...context, spanId: 'parent-1' }, { kind: 'run.started' }),
      observer.record({ ...context, runId: 'run-2', traceId: 'trace-2' }, { kind: 'qa.started' }),
    ]);
    const traces = capture.startSpan.mock.calls.map(([, trace]) => trace);
    expect(new Set(traces.map(trace => trace.spanId)).size).toBe(2);
    for (const trace of traces) {
      expect(capture.addEvent.mock.calls.filter(([eventTrace]) => eventTrace === trace)).toHaveLength(1);
      expect(capture.endSpan.mock.calls.filter(([endTrace]) => endTrace === trace)).toHaveLength(1);
    }
    expect(traces.find(trace => trace.traceId === context.traceId)?.parentSpanId).toBe('parent-1');
  });

  it('mirrors only durable events and preserves the authoritative local sequence', async () => {
    const root = await directory();
    const store = new JsonlEventStore({ root });
    const append = vi.fn<EventStoreProvider['append']>(async events => {
      expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: events[0].sequence });
    });
    const observer = createRunObserver(root, [{ provider: { id: 'mirror', capabilities: { append: true, read: false, verify: false }, append }, signals: ['events'] }]);
    await observer.record(context, { kind: 'run.started' });
    await observer.record(context, { kind: 'qa.started' });
    expect(append.mock.calls.map(([events]) => events[0])).toMatchObject([
      { runId: context.runId, sequence: 1, type: 'run.started', payload: { data: { kind: 'run.started' }, context } },
      { runId: context.runId, sequence: 2, type: 'qa.started' },
    ]);
  });

  it('isolates provider failures and never logs their secret-bearing error text', async () => {
    const root = await directory();
    const capture = provider();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    capture.startSpan.mockRejectedValue(new Error('token=private-auth-secret'));
    capture.addEvent.mockRejectedValue(new Error('token=private-auth-secret'));
    capture.endSpan.mockRejectedValue(new Error('token=private-auth-secret'));
    capture.record.mockRejectedValue(new Error('token=private-auth-secret'));
    await expect(createRunObserver(root, [{ provider: capture, signals: ['tracing', 'metrics'] }]).record(context, { kind: 'run.started' })).resolves.toMatchObject({ lastSequence: 1 });
    expect(await new JsonlEventStore({ root }).verify(context.runId)).toMatchObject({ valid: true, lastSequence: 1 });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-auth-secret');
  });

  it('keeps local persistence failures fatal and marks the exported span as failed', async () => {
    const root = await directory();
    const invalidRoot = join(root, 'file');
    await fs.writeFile(invalidRoot, 'not a directory');
    const capture = provider();
    await expect(createRunObserver(invalidRoot, [{ provider: capture, signals: ['tracing', 'metrics'] }]).record(context, { kind: 'run.started' })).rejects.toThrow();
    expect(capture.record).not.toHaveBeenCalled();
    expect(capture.addEvent).not.toHaveBeenCalled();
    expect(capture.endSpan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: true }));
  });

  it('bounds a hung exporter and aborts it before returning the persisted receipt', async () => {
    const root = await directory();
    const capture = provider();
    const startSpan = capture.startSpan.mockImplementation(() => new Promise(() => undefined));
    capture.addEvent.mockImplementation(() => new Promise(() => undefined));
    capture.record.mockImplementation(() => new Promise(() => undefined));
    capture.endSpan.mockImplementation(() => new Promise(() => undefined));
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const recording = createRunObserver(root, [{ provider: capture, signals: ['tracing', 'metrics'] }]).record(context, { kind: 'run.started' });
    await vi.waitFor(() => expect(startSpan).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(recording).resolves.toMatchObject({ lastSequence: 1 });
    expect(startSpan.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(capture.addEvent).not.toHaveBeenCalled();
    expect(capture.record).not.toHaveBeenCalled();
    expect(capture.endSpan).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe('createRunObserver', () => {
  it('persists audit events to the configured event store', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-run-observer-'));
    roots.push(root);
    const context = {
      traceId: 'trace-1', runId: 'run-1', workItemId: 'github:org/repo#1',
      profileId: 'test', attempt: 1, actor: { kind: 'cli' as const, id: 'test' },
    };

    await createRunObserver(root).record(context, {
      kind: 'run.requested',
      run: { id: context.runId, workItemId: context.workItemId, profileId: context.profileId, attempt: 1, status: 'pending' },
    });

    const store = new JsonlEventStore({ root });
    const events = [];
    for await (const event of store.read(context.runId)) events.push(event);
    expect(events).toMatchObject([{ type: 'run.requested', context }]);
    expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 1 });
  });
});
