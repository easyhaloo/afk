import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';
import { OtlpObservabilityProvider } from '../../infrastructure/observability/otlp-provider.js';
import { createRunObserver } from '../../infrastructure/observability/run-observer-factory.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { createConfiguredPlugins, getConfiguredCredentialDependencies, inspectConfiguredPlugins } from './configured.js';
import { PluginRuntime } from './runtime.js';

const runtimes: PluginRuntime[] = [];
const providers: OtlpObservabilityProvider[] = [];
const ref = { provider: 'named.collector', name: 'private-collector', scope: 'telemetry:write' };
const endpoint = 'https://collector.example.test/otlp';
const sample = { name: 'work.count', kind: 'counter' as const, value: 1 };
const context = { traceId: 'work', spanId: 'span' };

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const provider of providers.splice(0)) await provider.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(extraRef: { readonly [key: string]: PluginConfigValue } = {}, timeoutMs = 2_000) {
  const runtime = new PluginRuntime(); runtimes.push(runtime);
  const resolve = vi.fn(async (_ref: unknown, _options?: ProviderOperationOptions): Promise<CredentialValue> => ({ secret: 'Bearer first' }));
  await runtime.activate({
    manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
    activate(c) {
      c.registerCredentialProvider(ref.provider, { id: ref.provider, capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve });
    },
  });
  await runtime.activate({
    manifest: { id: 'credential.other', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
    activate(c) {
      c.registerCredentialProvider('other', { id: 'other', capabilities: { read: true, rotate: false, 'scoped-token': false }, resolve: async () => { throw new Error('wrong owner'); } });
    },
  });
  const fetch = vi.fn(async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => Response.json({}));
  const config = { endpoint, timeoutMs, headers: { Authorization: { ...ref, ...extraRef } } };
  const [plugin] = await createConfiguredPlugins({ configurations: [{ id: 'observability.otlp', config }], fetch });
  await runtime.activate(plugin);
  const provider = runtime.getObservabilityProvider('otlp') as OtlpObservabilityProvider;
  const used = () => fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
  return { runtime, resolve, fetch, plugin, provider, used, config };
}

describe('OTLP operation header references', () => {
  it('keeps discovery, activation, health, diagnostics, span capture and events passive', async () => {
    const f = await fixture();
    expect(inspectConfiguredPlugins({ configurations: [{ id: 'observability.otlp', config: f.config }] })[0]).toMatchObject({
      manifest: { provides: ['observability.provider'], requires: ['credential.provider'] }, credentialDependencies: [ref.provider],
    });
    expect(getConfiguredCredentialDependencies(f.plugin)).toEqual([ref.provider]);
    f.runtime.listPlugins(); f.runtime.listProvidersForPlugin(f.plugin.manifest.id);
    await f.plugin.health?.(); await f.plugin.diagnostics?.(); await f.runtime.health(); await f.runtime.diagnostics();
    await f.provider.startSpan('capture', context); await f.provider.addEvent(context, 'event');
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.runtime.dispose('credential.fixture')).rejects.toThrow('required');
    expect(f.runtime.getCredentialProvider(ref.provider)).toBeDefined();
  });

  it('resolves the exact scoped owner on every trace and metric export and sees rotation', async () => {
    const f = await fixture();
    await f.provider.startSpan('capture', context); await f.provider.endSpan(context);
    f.resolve.mockResolvedValue({ secret: 'Bearer rotated' }); await f.provider.record(sample);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.resolve.mock.calls[0][0]).toEqual({ name: ref.name, scope: ref.scope });
    expect(f.used()).toEqual(['Bearer first', 'Bearer rotated']);
    expect(f.fetch.mock.calls.map(([url]) => String(url))).toEqual([`${endpoint}/v1/traces`, `${endpoint}/v1/metrics`]);
    expect(f.resolve.mock.calls[0][1]?.deadlineAt).toBeTypeOf('number');
    expect(f.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('content-type') === 'application/json')).toBe(true);
  });

  it.each([null, { secret: '' }, { secret: ' ' }, { secret: 42 }, { secret: 'bad\rvalue' }, { secret: 'bad\nvalue' },
    { secret: 'bad\0value' }, { secret: 'value', revoked: true }, { secret: 'value', revoked: 'yes' },
    { secret: 'value', expiresAt: '2000-01-01T00:00:00Z' }, { secret: 'value', expiresAt: 'tomorrow' },
    { secret: 'value', expiresAt: '2026-11-15T00:00:00+99:99' }, { secret: '\u0100' }, { secret: 'x'.repeat(8192) },
  ])('rejects an unusable rotated credential without sending: %j', async value => {
    const f = await fixture(); await f.provider.record(sample);
    f.resolve.mockResolvedValue(value as CredentialValue);
    await expect(f.provider.record(sample)).rejects.toThrow('OTLP export failed');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.provider.health()).status).toBe('degraded');
    expect(JSON.stringify(await f.provider.doctor())).not.toContain(ref.name);
  });

  it('checks offset result expiry and reference expiry at the exact boundary', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const f = await fixture();
    f.resolve.mockResolvedValue({ secret: 'Bearer timed', expiresAt: '2026-11-15T08:00:01+08:00' });
    await f.provider.record(sample); vi.setSystemTime(new Date('2026-11-15T00:00:01Z'));
    await expect(f.provider.record(sample)).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.resolve).toHaveBeenCalledTimes(2);
    const g = await fixture({ expiresAt: '2026-11-15T00:00:02Z' });
    await g.provider.record(sample); vi.setSystemTime(new Date('2026-11-15T00:00:02Z'));
    await expect(g.provider.record(sample)).rejects.toThrow();
    expect(g.fetch).toHaveBeenCalledTimes(1); expect(g.resolve).toHaveBeenCalledTimes(1);
  });

  it('settles ignored cancellation and never sends a late credential or leaks its error', async () => {
    const f = await fixture(); const controller = new AbortController();
    let finish!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const deadlineAt = Date.now() + 500;
    const outcome = f.provider.record(sample, { signal: controller.signal, deadlineAt }).catch(error => error as Error);
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
    const operation = f.resolve.mock.calls[0][1]!;
    expect(operation.deadlineAt).toBe(deadlineAt);
    controller.abort(new Error('private-cancellation-detail'));
    expect((await outcome)?.message).toBe('OTLP operation cancelled'); expect(operation.signal?.aborted).toBe(true);
    finish({ secret: 'late-private-token' }); await Promise.resolve(); await Promise.resolve();
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.provider.record(sample, { signal: controller.signal })).rejects.toThrow('OTLP operation cancelled');
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([20, 500])('bounds credential resolution by the earlier caller or export deadline (%i)', async callerMs => {
    vi.useFakeTimers(); const f = await fixture({}, 40);
    let finish!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const startedAt = Date.now();
    const outcome = f.provider.record(sample, { deadlineAt: startedAt + callerMs }).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resolve.mock.calls[0][1]?.deadlineAt).toBe(startedAt + Math.min(40, callerMs));
    await vi.advanceTimersByTimeAsync(Math.min(40, callerMs));
    expect(await outcome).toBeInstanceOf(Error); expect(f.fetch).not.toHaveBeenCalled();
    finish({ secret: 'late' }); await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('shares one absolute budget between credential resolution and HTTP, ignoring late transport success', async () => {
    vi.useFakeTimers(); const f = await fixture({}, 40);
    f.resolve.mockImplementationOnce(() => new Promise(done => setTimeout(() => done({ secret: 'Bearer rotated' }), 25)));
    let finish!: (value: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const startedAt = Date.now();
    const outcome = f.provider.record(sample).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(25);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.resolve.mock.calls[0][1]?.deadlineAt).toBe(startedAt + 40);
    await vi.advanceTimersByTimeAsync(15); expect(await outcome).toBeInstanceOf(Error);
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    finish(Response.json({})); await vi.advanceTimersByTimeAsync(0);
    expect((await f.provider.health()).status).toBe('degraded');
  });

  it.each([NaN, Infinity, 1.5, -1])('rejects invalid or expired absolute deadline %s before resolving or sending', async deadlineAt => {
    const f = await fixture();
    await expect(f.provider.record(sample, { deadlineAt })).rejects.toThrow();
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it('settles disposal during resolution, reserves the owner until disposal, and isolates a reactivation', async () => {
    const f = await fixture(); let finish!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const outcome = f.provider.record(sample).catch(error => error as Error);
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
    await f.runtime.dispose(f.plugin.manifest.id);
    expect((await outcome)?.message).toBe('OTLP provider disposed');
    await f.runtime.activate(f.plugin);
    await (f.runtime.getObservabilityProvider('otlp') as OtlpObservabilityProvider).record(sample);
    finish({ secret: 'old-activation-private' }); await Promise.resolve(); await Promise.resolve();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await expect(f.provider.record(sample)).rejects.toThrow('disposed');
    await f.runtime.dispose(f.plugin.manifest.id); await f.runtime.dispose('credential.fixture');
  });

  it('isolates overlapping rotated exports', async () => {
    const f = await fixture();
    let finishA!: (value: CredentialValue) => void; let finishB!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finishA = done; })).mockImplementationOnce(() => new Promise(done => { finishB = done; }));
    const a = f.provider.record(sample); const b = f.provider.record(sample);
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(2));
    finishB({ secret: 'second' }); await b; finishA({ secret: 'first' }); await a;
    expect(f.used()).toEqual(['second', 'first']);
  });

  it('fails activation if the exact upstream is absent even with another owner', async () => {
    const runtime = new PluginRuntime(); runtimes.push(runtime);
    await runtime.activate({ manifest: { id: 'credential.other', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
      activate(c) { c.registerCredentialProvider('other', { id: 'other', capabilities: { read: true, rotate: false, 'scoped-token': false }, resolve: async () => ({ secret: 'unused' }) }); } });
    const [plugin] = await createConfiguredPlugins({ configurations: [{ id: 'observability.otlp', config: { endpoint, headers: { Authorization: ref } } }] });
    await expect(runtime.activate(plugin)).rejects.toThrow('credential provider is not active');
    expect(runtime.getObservabilityProvider('otlp')).toBeUndefined();
  });

  it('retains a terminal local success and separates capture failures from credential export failures', async () => {
    const f = await fixture(); f.resolve.mockResolvedValue({ secret: 'revoked-private', revoked: true });
    const root = await mkdtemp(join(tmpdir(), 'otlp-delivery-'));
    const capture = vi.fn(async () => { throw new Error('private-capture-detail'); });
    const upload = vi.fn();
    const observation = { traceId: 'trace', runId: 'run', workItemId: 'github:org/repo#1', profileId: 'test', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
    try {
      const observer = createRunObserver(root, [{ provider: f.provider, signals: ['tracing', 'metrics'] }], { artifacts: {
        captureEvents: true, evidence: { put: capture, get: async () => new Uint8Array() },
        provider: { id: 'fixture', capabilities: { write: true, read: false, list: false }, put: upload },
      } });
      const receipt = await observer.record(observation, { kind: 'run.finished', outcome: 'succeeded' });
      const history = [];
      for await (const event of new JsonlEventStore({ root }).read('run')) history.push(event);
      expect(receipt.lastSequence).toBe(1); expect(history).toHaveLength(2);
      expect(history[0].data).toEqual({ kind: 'run.finished', outcome: 'succeeded' });
      expect(history[1].data).toMatchObject({ kind: 'effect.completed', effectKind: 'observability.delivery', outcome: 'failed' });
      const summary = JSON.parse(history[1].data.kind === 'effect.completed' ? history[1].data.summary! : '{}');
      expect(summary).toMatchObject({ evidenceCaptureFailures: { failed: 1, timed_out: 0, cancelled: 0 }, counts: {
        tracing: { succeeded: 2, failed: 1, timed_out: 0, dropped: 0 }, metrics: { succeeded: 0, failed: 2, timed_out: 0, dropped: 0 },
      } });
      expect(f.resolve).toHaveBeenCalledTimes(3); expect(f.fetch).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
      expect(JSON.stringify(history)).not.toContain('private');
      expect(await new JsonlEventStore({ root }).verify('run')).toMatchObject({ valid: true, lastSequence: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('honors the host flush cancellation while resolving and drops queued exports without rewriting local success', async () => {
    const f = await fixture({}, 30_000);
    let finish!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const root = await mkdtemp(join(tmpdir(), 'otlp-flush-'));
    const observation = { traceId: 'trace', runId: 'flush', workItemId: 'github:org/repo#1', profileId: 'test', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      const observer = createRunObserver(root, [{ provider: f.provider, signals: ['tracing', 'metrics'] }]);
      const pending = observer.record(observation, { kind: 'run.finished', outcome: 'succeeded' });
      await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      const receipt = await pending;
      expect(receipt.lastSequence).toBe(1); expect(f.resolve.mock.calls[0][1]?.signal?.aborted).toBe(true);
      finish({ secret: 'late-flush-private' }); await vi.advanceTimersByTimeAsync(0);
      const history = [];
      for await (const event of new JsonlEventStore({ root }).read('flush')) history.push(event);
      expect(history[0].data).toEqual({ kind: 'run.finished', outcome: 'succeeded' }); expect(history).toHaveLength(2);
      const summary = JSON.parse(history[1].data.kind === 'effect.completed' ? history[1].data.summary! : '{}');
      expect(summary).toMatchObject({ evidenceCaptureFailures: { failed: 0, timed_out: 0, cancelled: 0 }, counts: {
        tracing: { succeeded: 1, failed: 0, timed_out: 0, dropped: 2 }, metrics: { succeeded: 0, failed: 0, timed_out: 1, dropped: 1 },
      } });
      expect(f.resolve).toHaveBeenCalledTimes(1); expect(f.fetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
  });
});

describe('OTLP direct operation boundary', () => {
  function provider(headers: ConstructorParameters<typeof OtlpObservabilityProvider>[0]['headers']) {
    const fetch = vi.fn(async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => Response.json({}));
    const instance = new OtlpObservabilityProvider({ endpoint, headers, fetch }); providers.push(instance);
    return { instance, fetch };
  }

  it('captures direct strings and configured environment values before their source changes', async () => {
    const headers = { Authorization: 'original' }; const f = provider(headers); headers.Authorization = 'changed';
    await f.instance.record(sample);
    expect(new Headers(f.fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('original');
    const environment = { TOKEN: 'env-original' };
    const [plugin] = await createConfiguredPlugins({ configurations: [{ id: 'observability.otlp', config: { endpoint, headers: { Authorization: { env: 'TOKEN' } } } }], environment, fetch: f.fetch });
    environment.TOKEN = 'env-changed';
    const runtime = new PluginRuntime(); runtimes.push(runtime); await runtime.activate(plugin);
    await (runtime.getObservabilityProvider('otlp') as OtlpObservabilityProvider).record(sample);
    expect(new Headers(f.fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('env-original');
  });

  it('revalidates an earlier header expiry after waiting for another header', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const f = provider({ Authorization: async () => ({ secret: 'first', expiresAt: '2026-11-15T00:00:00.010Z' }),
      'X-Second': async () => new Promise(done => setTimeout(() => done({ secret: 'second' }), 20)) });
    const outcome = f.instance.record(sample).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await outcome).toBeInstanceOf(Error); expect(f.fetch).not.toHaveBeenCalled();
  });

  it('bounds pending credentials as exports and frees capacity on disposal', async () => {
    const resolve = vi.fn(async () => new Promise<CredentialValue>(() => undefined));
    const f = provider({ Authorization: resolve });
    const pending = Array.from({ length: 32 }, () => f.instance.record(sample).catch(error => error as Error));
    await expect(f.instance.record(sample)).rejects.toThrow('concurrent export limit');
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(32));
    await f.instance.dispose();
    expect((await Promise.all(pending)).every(error => error?.message === 'OTLP provider disposed')).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('retains active-span and dropped-event limits before resolving credentials at export', async () => {
    const resolve = vi.fn(async () => ({ secret: 'Bearer value' }));
    const f = provider({ Authorization: resolve });
    for (let index = 0; index < 1024; index++) await f.instance.startSpan('span', { traceId: 'trace', spanId: String(index) });
    await expect(f.instance.startSpan('overflow', context)).rejects.toThrow('active span limit');
    const first = { traceId: 'trace', spanId: '0' };
    for (let index = 0; index < 130; index++) await f.instance.addEvent(first, 'event');
    expect(resolve).not.toHaveBeenCalled();
    await f.instance.endSpan(first);
    const payload = JSON.parse(String(f.fetch.mock.calls[0][1]?.body));
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({ events: expect.any(Array), droppedEventsCount: 2 });
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].events).toHaveLength(128);
    expect(resolve).toHaveBeenCalledTimes(1);
    await f.instance.startSpan('released', context);
  });
});
