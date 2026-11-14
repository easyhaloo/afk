import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginRuntime } from './runtime.js';
import { createPluginRunObserver, setPluginAuditArtifacts, setPluginAuditEvidence } from './observability.js';
import { createHash } from 'node:crypto';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { createLocalEncryptedEvidenceStore } from '../../infrastructure/observability/local-evidence-store.js';
import type { EvidenceRecord, EvidenceStoreProvider } from '../../plugin-sdk/capabilities.js';
import { observeRun } from '@afk/application';
import { replay } from '@afk/core';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('queries durable delivery summaries through normal observation without exporting or learning those summaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-intake-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const capture = vi.fn(async () => ({ blocked: [] }));
  const append = vi.fn(async () => { throw new Error('PROVIDER_CANARY'); });
  await runtime.load({
    manifest: { id: 'observability.accounting', version: '1.0.0', apiVersion: 1, provides: ['observe.event-store', 'workflow.action'], trusted: true },
    activate(setup) {
      setup.registerCapability('observe.event-store', 'selected', { id: 'PRIVATE_ID_CANARY', capabilities: { append: true }, append });
      setup.registerSystemAction('learning.settings', () => ({ enabled: true }));
      setup.registerSystemAction('learning.capture', capture);
    },
  });
  try {
    const context = { traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
    const observer = createPluginRunObserver(runtime, root);
    await observer.record(context, { kind: 'run.requested', run: { id: 'r', workItemId: context.workItemId, profileId: 'local', attempt: 1, status: 'pending' } });
    await observer.record(context, { kind: 'run.started' });
    await observer.record(context, { kind: 'qa.failed' });
    const observed = await observeRun('r', new JsonlEventStore({ root }));
    const summaries = observed.events.filter(event => event.data.kind === 'effect.completed' && event.data.effectKind === 'observability.delivery');
    expect(summaries).toHaveLength(3);
    expect(observed.integrity).toMatchObject({ valid: true, lastSequence: 6 });
    expect(observed.state.run?.status).toBe('running');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(observed)).not.toContain('CANARY');
  } finally { await runtime.dispose(); }
});

it('discovers generic and specialized registrations and exports each provider only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registered-observer-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const record = vi.fn(async () => undefined);
  const provider = { id: 'shared', capabilities: { counter: true, histogram: false, gauge: false }, record };
  await runtime.load({
    manifest: { id: 'observability.custom', version: '1.0.0', apiVersion: 1, provides: ['observability.provider', 'observe.metrics'], trusted: true },
    activate(context) {
      context.registerObservabilityProvider(provider.id, provider);
      context.registerCapability('observe.metrics', provider.id, provider);
    },
  });
  try {
    await createPluginRunObserver(runtime, root).record({ traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli', id: 'test' } }, { kind: 'run.started' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'counter', value: 1 }), expect.anything());
  } finally { await runtime.dispose(); }
});

it.each(['tracing', 'metrics', 'event-store'] as const)('limits a specialized %s registration to its declared signal', async signal => {
  const root = await mkdtemp(join(tmpdir(), 'specialized-observer-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const provider = {
    id: 'combined', capabilities: { span: true, event: true, counter: true, histogram: true, append: true },
    startSpan: vi.fn(async () => undefined), addEvent: vi.fn(async () => undefined), endSpan: vi.fn(async () => undefined),
    record: vi.fn(async () => undefined), append: vi.fn(async () => undefined),
  };
  await runtime.load({
    manifest: { id: 'observability.specialized', version: '1.0.0', apiVersion: 1, provides: [`observe.${signal}`], trusted: true },
    activate: context => context.registerCapability(`observe.${signal}`, provider.id, provider),
  });
  try {
    await createPluginRunObserver(runtime, root).record({ traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli', id: 'test' } }, { kind: 'run.started' });
    expect(provider.startSpan).toHaveBeenCalledTimes(signal === 'tracing' ? 1 : 0);
    expect(provider.addEvent).toHaveBeenCalledTimes(signal === 'tracing' ? 1 : 0);
    expect(provider.endSpan).toHaveBeenCalledTimes(signal === 'tracing' ? 1 : 0);
    expect(provider.record).toHaveBeenCalledTimes(signal === 'metrics' ? 2 : 0);
    expect(provider.append).toHaveBeenCalledTimes(signal === 'event-store' ? 1 : 0);
  } finally { await runtime.dispose(); }
});

it('uploads audit evidence through only the explicitly selected artifact registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selected-artifact-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const bytes = Buffer.from('verification output');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ref = { uri: `evidence://${sha256}`, sha256, mediaType: 'text/plain', classification: 'internal' as const, redactionStatus: 'not_required' as const };
  const selected = { id: 'selected', capabilities: { write: true, read: false, list: false }, put: vi.fn(async () => ({ uri: 'https://artifacts.example/proof', name: 'proof' })) };
  const unused = { ...selected, id: 'unused', put: vi.fn() };
  await runtime.load({
    manifest: { id: 'artifact.fixture', version: '1.0.0', apiVersion: 1, provides: ['artifact.provider'], trusted: true },
    activate(context) {
      context.registerArtifactProvider('selected-registration', selected);
      context.registerArtifactProvider('unused-registration', unused);
    },
  });
  try {
    const context = { traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
    await createPluginRunObserver(runtime, root, { artifacts: { provider: 'selected-registration', evidence: { get: async () => bytes } } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
    expect(selected.put).toHaveBeenCalledWith({ name: `${sha256}.bin`, mediaType: ref.mediaType, bytes }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(unused.put).not.toHaveBeenCalled();
    const store = new JsonlEventStore({ root });
    expect(await store.verify('r')).toMatchObject({ valid: true, lastSequence: 2 });
    await createPluginRunObserver(runtime, root).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
    expect(selected.put).toHaveBeenCalledTimes(1);
    expect(await store.verify('r')).toMatchObject({ valid: true, lastSequence: 3 });
  } finally { await runtime.dispose(); }
});

it('rejects an explicitly selected artifact registration that is unavailable', () => {
  expect(() => createPluginRunObserver(undefined, undefined, { artifacts: { provider: 'missing', evidence: { get: vi.fn() } } })).toThrow('Configured audit artifact provider is not registered');
});

it('inherits explicit runtime artifact selection and captures real evidence across engine observers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-artifact-capture-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const other = new PluginRuntime();
  const put = vi.fn(async () => ({ uri: 'https://artifacts.example/proof', name: 'proof' }));
  const register = () => ({
    manifest: { id: 'artifact.capture', version: '1.0.0', apiVersion: 1 as const, provides: ['artifact.provider'], trusted: true },
    activate(context: import('./runtime.js').PluginSetupContext) {
      context.registerArtifactProvider('remote', { id: 'remote', capabilities: { write: true, read: false, list: false }, put });
    },
  });
  await runtime.load(register());
  await other.load(register());
  try {
    const evidence = await createLocalEncryptedEvidenceStore(root);
    setPluginAuditArtifacts(runtime, { provider: 'remote', evidence, captureEvents: true });
    const context = { traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
    await createPluginRunObserver(other, root).record(context, { kind: 'qa.passed' });
    expect(put).not.toHaveBeenCalled();
    await createPluginRunObserver(runtime, root).record(context, { kind: 'qa.failed', summary: 'password=private-value' });
    await createPluginRunObserver(runtime, root).record(context, { kind: 'qa.passed' });
    expect(put).toHaveBeenCalledTimes(2);
    const store = new JsonlEventStore({ root });
    const events = [];
    for await (const event of store.read('r')) events.push(event);
    expect(events[0].evidence).toBeUndefined();
    for (const event of [events[1], events[3]]) {
      const bytes = await evidence.get(event.evidence![0]);
      expect(JSON.parse(Buffer.from(bytes).toString())).toMatchObject({ kind: event.data.kind, sourceEventId: event.id });
      expect(Buffer.from(bytes).toString()).not.toContain('private-value');
    }
    expect(await store.verify('r')).toMatchObject({ valid: true, lastSequence: 5 });
  } finally { await runtime.dispose(); await other.dispose(); }
});

async function evidenceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'selected-sdk-evidence-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const evidence = await createLocalEncryptedEvidenceStore(root);
  const records = new Map<string, Omit<EvidenceRecord, 'bytes'>>();
  const selected: EvidenceStoreProvider = {
    id: 'private', capabilities: { put: true, get: true, classify: false },
    put: vi.fn(async (record, operation) => {
      if (operation?.signal?.aborted) throw new Error('cancelled');
      const { bytes, ...metadata } = record;
      records.set(record.id, metadata);
      await writeFile(join(root, record.id), bytes);
      return { uri: `file://${join(root, record.id)}`, name: record.id };
    }),
    get: vi.fn(async (id, operation) => {
      if (operation?.signal?.aborted) throw new Error('cancelled');
      return { ...records.get(id)!, bytes: await readFile(join(root, id)) };
    }),
  };
  const unused = { ...selected, id: 'unused', put: vi.fn(selected.put), get: vi.fn(selected.get) };
  await runtime.load({
    manifest: { id: 'evidence.fixture', version: '1.0.0', apiVersion: 1, provides: ['observe.evidence'], trusted: true },
    activate(context) {
      context.registerCapability('observe.evidence', 'private', selected);
      context.registerCapability('observe.evidence', 'unused', unused);
    },
  });
  const context = { traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
  return { root, runtime, evidence, selected, unused, context };
}

it.each(['succeeded', 'put-failed', 'mismatch', 'cancelled'] as const)('queries the actual terminal SDK evidence %s receipt without recursive export or learning', async mode => {
  const { root, runtime, evidence, selected, unused, context } = await evidenceFixture();
  const events = join(root, 'events');
  const controller = new AbortController();
  let release: (() => void) | undefined;
  const capture = vi.fn(async () => ({ blocked: [] }));
  const append = vi.fn(async () => { throw new Error('EXPORT_CANARY'); });
  try {
    const initial = createPluginRunObserver(runtime, events);
    await initial.record(context, { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId, profileId: context.profileId, attempt: 1, status: 'pending' } });
    await initial.record(context, { kind: 'run.started' });
    if (mode === 'put-failed') vi.mocked(selected.put).mockRejectedValue(new Error('EVIDENCE_CANARY'));
    if (mode === 'mismatch') vi.mocked(selected.get).mockResolvedValue({ id: 'foreign', mediaType: 'application/json', classification: 'internal', bytes: Buffer.from('EVIDENCE_CANARY') });
    if (mode === 'cancelled') vi.mocked(selected.put).mockImplementation(async (record, operation) => {
      controller.abort(new Error('CANCEL_CANARY'));
      await new Promise<void>(resolve => { release = resolve; });
      expect(operation?.signal?.aborted).toBe(true);
      return { name: record.id, uri: `evidence://${record.id}` };
    });
    await runtime.load({
      manifest: { id: 'evidence.terminal', version: '1.0.0', apiVersion: 1, provides: ['observe.event-store', 'workflow.action'], trusted: true },
      activate(setup) {
        setup.registerCapability('observe.event-store', 'terminal', { id: 'terminal', capabilities: { append: true }, append });
        setup.registerSystemAction('learning.settings', () => ({ enabled: true }));
        setup.registerSystemAction('learning.capture', capture);
      },
    });
    setPluginAuditEvidence(runtime, { provider: 'private', scopes: ['github:org/repo'], evidence, signal: controller.signal });
    const receipt = await createPluginRunObserver(runtime, events).record(context, { kind: 'run.finished', outcome: 'succeeded' });
    const read = async () => { const history = []; for await (const event of new JsonlEventStore({ root: events }).read(context.runId)) history.push(event); return history; };
    const history = await read();
    expect(history.map(event => event.data.kind === 'effect.completed' ? event.data.effectKind : event.data.kind))
      .toEqual(['run.requested', 'run.started', 'run.finished', 'evidence.mirror', 'observability.delivery']);
    expect(receipt).toMatchObject({ lastSequence: 3, lastHash: history[2].integrity.hash });
    expect(history[3]).toMatchObject({ causationId: history[2].id, data: { outcome: mode === 'succeeded' ? 'succeeded' : 'failed' } });
    expect(JSON.parse(history[3].data.kind === 'effect.completed' ? history[3].data.summary! : '{}'))
      .toMatchObject({ sourceEventId: history[2].id, sourceSequence: 3, ...(mode === 'cancelled' ? { reason: 'cancelled' } : {}) });
    expect(await evidence.get(history[2].evidence![0])).toBeInstanceOf(Uint8Array);
    expect(selected.put).toHaveBeenCalledTimes(1);
    expect(selected.get).toHaveBeenCalledTimes(mode === 'succeeded' || mode === 'mismatch' ? 1 : 0);
    expect(unused.put).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(history)).not.toContain('CANARY');
    if (release) { release(); await Promise.resolve(); await Promise.resolve(); expect(await read()).toEqual(history); expect(selected.get).not.toHaveBeenCalled(); }
    const observed = await observeRun(context.runId, new JsonlEventStore({ root: events }));
    expect(observed.integrity).toMatchObject({ valid: true, lastSequence: 5 });
    expect(observed.state).toMatchObject({ terminal: true, sequence: 5, run: { status: 'succeeded' } });
    expect(replay(observed.events)).toEqual(observed.state);
    expect(() => replay([...observed.events, { ...history[3], sequence: 6, type: 'qa.passed', data: { kind: 'qa.passed' } }]))
      .toThrow('after terminal event');
  } finally { release?.(); await runtime.dispose(); }
});

it('consumes only explicitly selected SDK evidence after authoritative encrypted persistence', async () => {
  const { root, runtime, evidence, selected, unused, context } = await evidenceFixture();
  try {
    const events = join(root, 'events');
    await createPluginRunObserver(runtime, events).record(context, { kind: 'qa.passed' });
    expect(selected.put).not.toHaveBeenCalled();
    expect(unused.put).not.toHaveBeenCalled();
    await createPluginRunObserver(runtime, events, {
      evidenceStore: { provider: 'private', scopes: ['github:org/repo'], evidence },
    }).record(context, { kind: 'qa.failed', summary: 'password=fixture-private' });
    expect(selected.put).toHaveBeenCalledTimes(1);
    expect(selected.get).toHaveBeenCalledTimes(1);
    expect(unused.put).not.toHaveBeenCalled();
    expect(unused.get).not.toHaveBeenCalled();
    const received = vi.mocked(selected.put).mock.calls[0][0];
    expect(received.id).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(received.bytes).toString()).not.toContain('fixture-private');
    expect(JSON.parse(Buffer.from(received.bytes).toString())).toMatchObject({ kind: 'qa.failed' });
    const history = [];
    const audit = new JsonlEventStore({ root: events });
    for await (const event of audit.read('r')) history.push(event);
    const source = history.find(event => event.type === 'qa.failed')!;
    const ref = source.evidence![0];
    expect(await evidence.get(ref)).toEqual(Buffer.from(received.bytes));
    expect(await readFile(join(root, '.afk', 'evidence', `${ref.sha256}.bin`))).not.toEqual(Buffer.from(received.bytes));
    expect(history.at(-1)?.data).toMatchObject({ kind: 'effect.completed', effectKind: 'evidence.mirror', outcome: 'succeeded' });
    expect(await audit.verify('r')).toMatchObject({ valid: true, lastSequence: 3 });
  } finally { await runtime.dispose(); }
});

it('revokes a previously created observer when its explicit runtime selection changes', async () => {
  const { root, runtime, evidence, selected, context } = await evidenceFixture();
  try {
    setPluginAuditEvidence(runtime, { provider: 'private', scopes: ['github:org/repo'], evidence });
    const observer = createPluginRunObserver(runtime, join(root, 'events'));
    setPluginAuditEvidence(runtime, { provider: 'unused', scopes: ['github:org/other'], evidence });
    await observer.record(context, { kind: 'qa.passed' });
    expect(selected.put).not.toHaveBeenCalled();
    expect(selected.get).not.toHaveBeenCalled();
    expect(await new JsonlEventStore({ root: join(root, 'events') }).verify(context.runId)).toMatchObject({ valid: true, lastSequence: 1 });
  } finally { await runtime.dispose(); }
});

it('does not retain permission after its selected provider is unloaded', async () => {
  const { root, runtime, evidence, selected, context } = await evidenceFixture();
  try {
    const observer = createPluginRunObserver(runtime, join(root, 'events'), { evidenceStore: { provider: 'private', scopes: ['github:org/repo'], evidence } });
    await runtime.dispose('evidence.fixture');
    await observer.record(context, { kind: 'qa.passed' });
    expect(selected.put).not.toHaveBeenCalled();
    expect(selected.get).not.toHaveBeenCalled();
  } finally { await runtime.dispose(); }
});

it.each(['unloaded', 'ambiguous', 'unavailable'] as const)('preserves new observers local audit when accepted evidence selection becomes %s', async mode => {
  const { root, runtime, evidence, selected, unused, context } = await evidenceFixture();
  const onFailure = vi.fn(() => { throw new Error('synthetic-diagnostic-failure'); });
  const events = join(root, 'events');
  try {
    setPluginAuditEvidence(runtime, { provider: 'private', scopes: ['github:org/repo'], evidence, onFailure });
    const existing = createPluginRunObserver(runtime, events);
    if (mode === 'unloaded') await runtime.dispose('evidence.fixture');
    else if (mode === 'unavailable') Object.assign(selected, { capabilities: { put: true, get: false, classify: false } });
    else await runtime.load({
      manifest: { id: 'evidence.ambiguous', version: '1.0.0', apiVersion: 1, provides: ['observability.provider'], trusted: true },
      activate: setup => setup.registerObservabilityProvider('private', { ...selected }),
    });
    await existing.record(context, { kind: 'qa.passed' });
    await createPluginRunObserver(runtime, events).record(context, { kind: 'qa.passed' });
    expect(onFailure).toHaveBeenCalledWith('provider_unavailable');
    expect(selected.put).not.toHaveBeenCalled();
    expect(selected.get).not.toHaveBeenCalled();
    expect(unused.put).not.toHaveBeenCalled();
    expect(unused.get).not.toHaveBeenCalled();
    expect(await new JsonlEventStore({ root: events }).verify(context.runId)).toMatchObject({ valid: true, lastSequence: mode === 'ambiguous' ? 3 : 2 });
  } finally { await runtime.dispose(); }
});

it.each(['same', 'different'] as const)('handles %s specialized and generic EvidenceStore registrations explicitly', async identity => {
  const { root, runtime, evidence, selected, context } = await evidenceFixture();
  try {
    await runtime.load({
      manifest: { id: 'evidence.generic', version: '1.0.0', apiVersion: 1, provides: ['observability.provider'], trusted: true },
      activate: setup => setup.registerObservabilityProvider('private', identity === 'same' ? selected : { ...selected }),
    });
    const create = () => createPluginRunObserver(runtime, join(root, 'events'), { evidenceStore: { provider: 'private', scopes: ['github:org/repo'], evidence } });
    if (identity === 'different') expect(create).toThrow('ambiguous');
    else {
      await create().record(context, { kind: 'qa.passed' });
      expect(selected.put).toHaveBeenCalledTimes(1);
      expect(selected.get).toHaveBeenCalledTimes(1);
    }
  } finally { await runtime.dispose(); }
});

it('rejects a selected EvidenceStore without both put and get capabilities', async () => {
  const { root, runtime, evidence, selected } = await evidenceFixture();
  try {
    Object.assign(selected, { capabilities: { put: true, get: false, classify: false } });
    expect(() => createPluginRunObserver(runtime, root, { evidenceStore: { provider: 'private', scopes: ['github:org/repo'], evidence } })).toThrow('unavailable');
    expect(selected.put).not.toHaveBeenCalled();
  } finally { await runtime.dispose(); }
});
