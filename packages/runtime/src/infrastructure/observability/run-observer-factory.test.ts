import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../io/logger.js';
import type { EvidenceRecord, EvidenceStoreProvider, MetricsProvider, TracerProvider, EventStoreProvider, ProviderAbortSignal } from '../../plugin-sdk/capabilities.js';
import { JsonlEventStore } from './jsonl-event-store.js';
import { createRunObserver } from './run-observer-factory.js';
import { createLocalEncryptedEvidenceStore, type LocalEncryptedEvidenceStore } from './local-evidence-store.js';

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
    startSpan: vi.fn<Parameters<TracerProvider['startSpan']>, ReturnType<TracerProvider['startSpan']>>(async () => undefined),
    addEvent: vi.fn<Parameters<TracerProvider['addEvent']>, ReturnType<TracerProvider['addEvent']>>(async () => undefined),
    endSpan: vi.fn<Parameters<NonNullable<TracerProvider['endSpan']>>, ReturnType<NonNullable<TracerProvider['endSpan']>>>(async () => undefined),
    record: vi.fn<Parameters<MetricsProvider['record']>, ReturnType<MetricsProvider['record']>>(async () => undefined),
  };
}

function plainEvidence(): Pick<LocalEncryptedEvidenceStore, 'put' | 'get'> {
  const records = new Map<string, Uint8Array>();
  return {
    async put(input) {
      const bytes = Buffer.from(input.bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      records.set(sha256, bytes);
      return { uri: `evidence://${sha256}`, sha256, mediaType: input.mediaType, classification: input.classification, redactionStatus: input.redactionStatus };
    },
    async get(ref) {
      const bytes = records.get(ref.sha256);
      if (!bytes) throw new Error('Missing fixture evidence');
      return Buffer.from(bytes);
    },
  };
}

async function sdkEvidence(usePlainCapture = false) {
  const root = await directory();
  const evidence = usePlainCapture ? plainEvidence() : await createLocalEncryptedEvidenceStore(root);
  const records = new Map<string, EvidenceRecord>();
  const sdk: EvidenceStoreProvider = {
    id: 'private', capabilities: { put: true, get: true, classify: false },
    put: vi.fn(async record => {
      records.set(record.id, { ...record, bytes: Buffer.from(record.bytes) });
      return { name: record.id, uri: `evidence://${record.id}` };
    }),
    get: vi.fn(async id => records.get(id)!),
  };
  const events = join(root, 'events');
  const history = async () => {
    const result = [];
    for await (const event of new JsonlEventStore({ root: events }).read(context.runId)) result.push(event);
    return result;
  };
  return { root, events, evidence, sdk, history };
}

describe('explicit SDK evidence mirror boundaries', () => {
  it.each(['github:org/other#1', 'gitlab:org/repo#1', 'not-a-work-item'])('keeps foreign or invalid scope %s local', async workItemId => {
    const { events, evidence, sdk, history } = await sdkEvidence();
    await createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence } }).record({ ...context, workItemId }, { kind: 'qa.passed' });
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.get).not.toHaveBeenCalled();
    expect(await history()).toHaveLength(1);
  });

  it('does not send arbitrary existing, sensitive or restricted evidence references', async () => {
    const { events, evidence, sdk, history } = await sdkEvidence();
    const foreign = await evidence.put({ bytes: Buffer.from('foreign-private-attachment'), mediaType: 'text/plain', classification: 'sensitive', redactionStatus: 'restricted' });
    await createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [foreign] });
    expect(sdk.put).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sdk.put).mock.calls[0][0];
    expect(Buffer.from(sent.bytes).toString()).not.toContain('foreign-private-attachment');
    expect(sent.classification).toBe('internal');
    const source = (await history())[0];
    expect(source.evidence).toHaveLength(2);
    expect(source.evidence![0]).toEqual(foreign);
    expect(await evidence.get(foreign)).toEqual(Buffer.from('foreign-private-attachment'));
  });

  it.each(['hash', 'size', 'sourceEventId', 'kind', 'occurredAt', 'classification', 'mediaType', 'restricted'] as const)('rejects invalid local capture %s before sending private bytes', async mode => {
    const { events, evidence, sdk, history } = await sdkEvidence();
    const local = {
      get: async (ref: Parameters<typeof evidence.get>[0]) => mode === 'hash' ? Buffer.from('wrong bytes') : evidence.get(ref),
      put: async (input: Parameters<typeof evidence.put>[0]) => {
        if (mode === 'classification') return evidence.put({ ...input, classification: 'sensitive' });
        if (mode === 'mediaType') return evidence.put({ ...input, mediaType: 'text/plain' });
        if (mode === 'restricted') return evidence.put({ ...input, redactionStatus: 'restricted' });
        if (['sourceEventId', 'kind', 'occurredAt'].includes(mode)) {
          const value = JSON.parse(Buffer.from(input.bytes).toString());
          value[mode] = 'foreign';
          return evidence.put({ ...input, bytes: Buffer.from(JSON.stringify(value)) });
        }
        return evidence.put(input);
      },
    };
    await createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence: local, maxBytes: mode === 'size' ? 1 : 65_536 } }).record(context, { kind: 'qa.passed' });
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.get).not.toHaveBeenCalled();
    expect((await history()).at(-1)?.data).toMatchObject({ effectKind: 'evidence.mirror', outcome: 'failed' });
  });

  it.each(['id', 'mediaType', 'classification', 'bytes', 'oversized', 'put-error', 'get-error', 'receipt'] as const)('preserves local evidence when SDK %s is invalid', async mode => {
    const { events, evidence, sdk, history } = await sdkEvidence();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    if (mode === 'put-error') vi.mocked(sdk.put).mockRejectedValue(new Error('token=provider-private'));
    if (mode === 'receipt') vi.mocked(sdk.put).mockResolvedValue({ uri: 'https://example.test/private', name: 'foreign-id' });
    const get = vi.mocked(sdk.get).getMockImplementation()!;
    vi.mocked(sdk.get).mockImplementation(async id => {
      if (mode === 'get-error') throw new Error('token=provider-private');
      const record = await get(id);
      return mode === 'id' ? { ...record, id: 'foreign-id' }
        : mode === 'mediaType' ? { ...record, mediaType: 'text/plain' }
        : mode === 'classification' ? { ...record, classification: 'public' }
        : mode === 'bytes' ? { ...record, bytes: Buffer.from('substituted') }
        : mode === 'oversized' ? { ...record, bytes: Buffer.alloc(65_537) }
        : record;
    });
    await createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence } }).record(context, { kind: 'qa.passed' });
    const source = (await history())[0];
    expect(JSON.parse(Buffer.from(await evidence.get(source.evidence![0])).toString())).toMatchObject({ kind: 'qa.passed', sourceEventId: source.id });
    expect((await history()).at(-1)?.data).toMatchObject({ effectKind: 'evidence.mirror', outcome: 'failed' });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('provider-private');
    expect(await new JsonlEventStore({ root: events }).verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
  });

  it.each(['before', 'put', 'get', 'timeout'] as const)('keeps local success on cancellation at %s', async stage => {
    const { events, evidence, sdk, history } = await sdkEvidence(true);
    const controller = new AbortController();
    let receivedSignal: ProviderAbortSignal | undefined;
    let release: (() => void) | undefined;
    if (stage === 'before') controller.abort(null);
    if (stage === 'put' || stage === 'timeout') vi.mocked(sdk.put).mockImplementation(async (_record, operation) => {
      receivedSignal = operation?.signal;
      if (stage === 'put') controller.abort(null);
      await new Promise<void>(resolve => { release = resolve; });
      return { name: 'late', uri: 'file:///late' };
    });
    if (stage === 'get') vi.mocked(sdk.get).mockImplementation(async (_id, operation) => {
      receivedSignal = operation?.signal;
      controller.abort(null);
      await new Promise<void>(resolve => { release = resolve; });
      return {} as EvidenceRecord;
    });
    const started = performance.now();
    await createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence, signal: controller.signal, timeoutMs: 20 } }).record(context, { kind: 'qa.passed' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect((await history()).at(-1)?.data).toMatchObject({ effectKind: 'evidence.mirror', outcome: 'failed' });
    expect(await evidence.get((await history())[0].evidence![0])).toBeInstanceOf(Uint8Array);
    if (stage === 'before') expect(sdk.put).not.toHaveBeenCalled();
    else expect(receivedSignal?.aborted).toBe(true);
    release?.();
    await Promise.resolve();
    if (stage !== 'get') expect(sdk.get).not.toHaveBeenCalled();
  });

  it.each(['active', 'preaborted'] as const)('keeps capture deadline separate from provider cancellation when %s', async state => {
    const { events, evidence, sdk, history } = await sdkEvidence(true);
    const controller = new AbortController();
    if (state === 'preaborted') controller.abort(null);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let late!: ReturnType<typeof evidence.put>;
    const local = { get: evidence.get, put: (input: Parameters<typeof evidence.put>[0]) => {
      late = held.then(() => evidence.put(input));
      return late;
    } };
    const onFailure = vi.fn();
    const receipt = await createRunObserver(events, [], { evidenceStore: {
      provider: sdk, scopes: ['github:org/repo'], evidence: local, signal: controller.signal, timeoutMs: 20, onFailure,
    } }).record(context, { kind: 'qa.passed' });
    const stored = await history();
    expect(receipt).toMatchObject({ lastSequence: 1, lastHash: stored[0].integrity.hash });
    expect(stored[0].data).toEqual({ kind: 'qa.passed' });
    expect(stored[0].evidence).toBeUndefined();
    expect(stored.filter(event => event.data.kind === 'effect.completed' && event.data.effectKind === 'evidence.mirror')).toHaveLength(0);
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.get).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    release();
    await late;
    expect(await history()).toEqual(stored);
  });

  it('never calls the SDK when authoritative event persistence fails', async () => {
    const { events, evidence, sdk } = await sdkEvidence();
    await fs.writeFile(events, 'not a directory');
    await expect(createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence } }).record(context, { kind: 'qa.passed' })).rejects.toThrow();
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.get).not.toHaveBeenCalled();
  });

  it.each(['put', 'get'] as const)('preserves source success when local evidence %s fails', async operation => {
    const { events, evidence, sdk, history } = await sdkEvidence();
    const local = {
      put: operation === 'put' ? async () => { throw new Error('token=local-private'); } : evidence.put.bind(evidence),
      get: operation === 'get' ? async () => { throw new Error('token=local-private'); } : evidence.get.bind(evidence),
    };
    await createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence: local } }).record(context, { kind: 'qa.passed' });
    const stored = await history();
    expect(stored[0].data).toMatchObject({ kind: 'qa.passed' });
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.get).not.toHaveBeenCalled();
    expect(stored).toHaveLength(operation === 'put' ? 1 : 2);
    expect(JSON.stringify(stored)).not.toContain('local-private');
  });

  it('binds records to their project, run, work item and source event', async () => {
    const { events, evidence, sdk, history } = await sdkEvidence();
    const observer = createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo', 'github:org/other'], evidence } });
    await observer.record(context, { kind: 'qa.passed' });
    await observer.record({ ...context, runId: 'run-2' }, { kind: 'qa.passed' });
    await observer.record({ ...context, workItemId: 'github:org/other#1' }, { kind: 'qa.passed' });
    expect(new Set(vi.mocked(sdk.put).mock.calls.map(([record]) => record.id)).size).toBe(3);
    expect((await history()).filter(event => event.data.kind === 'effect.completed').every(event => event.data.kind === 'effect.completed' && event.data.outcome === 'succeeded')).toBe(true);
  });

  it('pins source scope and identity before asynchronous local persistence', async () => {
    const { events, evidence, sdk, history } = await sdkEvidence();
    const changing = { ...context };
    const local = {
      get: evidence.get.bind(evidence),
      async put(input: Parameters<typeof evidence.put>[0]) {
        changing.workItemId = 'github:org/foreign#1';
        return evidence.put(input);
      },
    };
    await createRunObserver(events, [], { evidenceStore: { provider: sdk, scopes: ['github:org/repo'], evidence: local } }).record(changing, { kind: 'qa.passed' });
    expect((await history())[0].context.workItemId).toBe('github:org/repo#1');
    expect((await history()).at(-1)?.context.workItemId).toBe('github:org/repo#1');
  });
});

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
    const append = vi.fn<Parameters<EventStoreProvider['append']>, ReturnType<EventStoreProvider['append']>>(async events => {
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
