import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginRuntime } from './runtime.js';
import { createPluginRunObserver, setPluginAuditArtifacts } from './observability.js';
import { createHash } from 'node:crypto';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { createLocalEncryptedEvidenceStore } from '../../infrastructure/observability/local-evidence-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
