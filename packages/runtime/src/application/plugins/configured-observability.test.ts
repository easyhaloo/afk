import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialProvider, EventStoreProvider, EvidenceStoreProvider, MetricsProvider, TracerProvider } from '../../plugin-sdk/capabilities.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';
import { OtlpObservabilityProvider } from '../../infrastructure/observability/otlp-provider.js';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { createConfiguredPlugins, getConfiguredCredentialDependencies, type ConfiguredPluginsOptions } from './configured.js';
import { PluginRuntime } from './runtime.js';

type Configuration = ConfiguredPluginsOptions['configurations'][number];
const endpoint = 'https://collector.example.test/otlp';
const runtimes: PluginRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function runtime(): PluginRuntime {
  const instance = new PluginRuntime();
  runtimes.push(instance);
  return instance;
}

function configure(config?: Configuration['config'], options: Partial<ConfiguredPluginsOptions> = {}) {
  return createConfiguredPlugins({ configurations: [{ id: 'observability.otlp', config }], environment: {}, ...options });
}

async function registerCredential(instance: PluginRuntime, resolve: CredentialProvider['resolve']) {
  await instance.activate({
    manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
    activate(context) {
      context.registerCredentialProvider('fixture', { id: 'fixture', capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve });
    },
  });
}

describe('configured observability plugins', () => {
  it.each<Configuration['config']>([undefined, {}, { serviceName: 'afk' }])('requires an endpoint with config %j', async config => {
    await expect(configure(config)).rejects.toThrow(/plugin 'observability.otlp'.*endpoint \(required\)/);
  });

  it.each<Configuration['config']>([
    { endpoint, unknown: true },
    { endpoint, token: 'raw-secret' },
    { endpoint, serviceName: '' },
    { endpoint, serviceName: 'bad\nservice' },
    { endpoint, timeoutMs: 0 },
    { endpoint, timeoutMs: -1 },
    { endpoint, timeoutMs: 1.5 },
    { endpoint, timeoutMs: 300_001 },
    { endpoint, timeoutMs: '2000' },
    { endpoint, resourceAttributes: { nested: { value: true } } },
    { endpoint, resourceAttributes: { array: ['value'] } },
    { endpoint, resourceAttributes: { empty: null } },
    { endpoint, resourceAttributes: { invalid: Infinity } },
  ])('rejects invalid settings %j', async config => {
    await expect(configure(config)).rejects.toThrow(/plugin 'observability.otlp': invalid configuration fields/);
  });

  it.each([
    '', 'not-a-url', 'file:///tmp/collector', 'ftp://collector.example.test',
    'https://user:password@collector.example.test', 'https://collector.example.test?token=private',
    'https://collector.example.test#fragment', 'https://collector.example.test?', 'https://collector.example.test#',
    'https://collector.example.test/\r\nheader',
  ])('rejects unsafe endpoint %j', async value => {
    await expect(configure({ endpoint: value })).rejects.toThrow(/plugin 'observability.otlp':/);
  });

  it.each([
    '', 'bad header', 'bad:header', 'bad\r\nheader', ':authority',
    'Host', 'hOsT', 'Content-Type', 'CONTENT-LENGTH', 'Content-Encoding',
    'Transfer-Encoding', 'Connection', 'Keep-Alive', 'TE', 'Trailer', 'Upgrade', 'Expect',
    'Forwarded', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Original-URL', 'X-Rewrite-URL',
  ])('rejects unsafe header name %j', async name => {
    const network = vi.fn();
    await expect(configure({ endpoint, headers: { [name]: { env: 'TOKEN' } } }, {
      environment: { TOKEN: 'private-token' }, fetch: network,
    })).rejects.toThrow(/invalid configuration fields/);
    expect(network).not.toHaveBeenCalled();
  });

  it.each<PluginConfigValue>([
    'Bearer raw-secret', null, {}, { provider: 'fixture' }, { provider: 'fixture', name: '' },
    { provider: 'INVALID', name: 'token' }, { provider: 'fixture', name: 'token', scope: '' },
    { provider: 'fixture', name: 'token', extra: true }, { provider: 'fixture', name: 'token\r\nheader' },
    { env: 'MISSING' }, { env: 'BAD-NAME' }, { env: 'TOKEN', extra: true },
    { env: 'TOKEN', provider: 'fixture', name: 'token' },
  ])('rejects invalid header credential reference %j', async reference => {
    await expect(configure({ endpoint, headers: { Authorization: reference } }, {
      environment: { TOKEN: 'private-token' },
    })).rejects.toThrow('invalid configuration fields');
  });

  it.each(['', ' ', 'private\rvalue', 'private\nvalue', 'private\0value'])('rejects invalid environment header values %j', async value => {
    await expect(configure({ endpoint, headers: { Authorization: { env: 'TOKEN' } } }, {
      environment: { TOKEN: value },
    })).rejects.toThrow('invalid configuration fields');
  });

  it('validates scoped references without resolving credentials or contacting the collector', async () => {
    const instance = runtime();
    const resolve = vi.fn(async () => ({ secret: 'Bearer private-token' }));
    await registerCredential(instance, resolve);
    const network = vi.fn();
    const execute = vi.fn();
    const [plugin] = await configure({
      endpoint, headers: { Authorization: { provider: 'fixture', name: 'collector', scope: 'telemetry:write' } },
    }, { fetch: network, execute });
    expect(plugin.manifest).toMatchObject({ id: 'observability.otlp', provides: ['observability.provider'], requires: ['credential.provider'], trusted: true });
    expect(getConfiguredCredentialDependencies(plugin)).toEqual(['fixture']);
    await expect(plugin.health!()).resolves.toMatchObject({ status: 'unknown' });
    await expect(plugin.diagnostics!()).resolves.toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await instance.activate(plugin);
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({ name: 'collector', scope: 'telemetry:write' });
    expect(network).not.toHaveBeenCalled();
    expect(instance.getObservabilityProvider('otlp')).toBeInstanceOf(OtlpObservabilityProvider);
  });

  it('orders configured credential providers before their observability consumer', async () => {
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(Response.json({}));
    const plugins = await createConfiguredPlugins({ configurations: [
      { id: 'observability.otlp', config: { endpoint, headers: { Authorization: { provider: 'credential.enterprise', name: 'collector' } } } },
      { id: 'credential.enterprise', config: { values: { collector: { env: 'TOKEN' } } } },
    ], environment: { TOKEN: 'Bearer private-token' }, fetch: network });
    expect(plugins.map(plugin => plugin.manifest.id)).toEqual(['credential.enterprise', 'observability.otlp']);
    const instance = runtime();
    for (const plugin of plugins) await instance.activate(plugin);
    const provider = instance.getObservabilityProvider('otlp') as MetricsProvider;
    await provider.record({ name: 'configured.counter', value: 1 });
    expect(new Headers(network.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer private-token');
  });

  it.each(['', ' ', 'private\rvalue', 'private\nvalue', 'private\0value'])('rejects invalid resolved header values %j during activation', async value => {
    const instance = runtime();
    const resolve = vi.fn(async () => ({ secret: value }));
    await registerCredential(instance, resolve);
    const network = vi.fn();
    const [plugin] = await configure({ endpoint, headers: { Authorization: { provider: 'fixture', name: 'collector' } } }, { fetch: network });
    expect(resolve).not.toHaveBeenCalled();
    await expect(instance.activate(plugin)).rejects.toThrow(/resolved.*credential.*invalid/);
    expect(instance.getObservabilityProvider('otlp')).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
    if (value.trim()) expect(JSON.stringify(await instance.diagnostics())).not.toContain(value);
  });

  it('redacts credentials in health and diagnostics and resolves again after disposal', async () => {
    const instance = runtime();
    const resolve = vi.fn(async () => ({ secret: 'first-private-token' }));
    await registerCredential(instance, resolve);
    const [plugin] = await configure({ endpoint, headers: { Authorization: { provider: 'fixture', name: 'collector' } } });
    await instance.activate(plugin);
    const provider = instance.getObservabilityProvider('otlp') as OtlpObservabilityProvider;
    vi.spyOn(provider, 'health').mockResolvedValue({ status: 'unavailable', message: 'first-private-token' });
    vi.spyOn(provider, 'doctor').mockResolvedValue([{ check: 'first-private-token', ok: false, detail: 'first-private-token' }]);
    const dispose = vi.spyOn(provider, 'dispose');
    await expect(instance.health(plugin.manifest.id)).resolves.toMatchObject([{ status: 'unhealthy', message: '[redacted]' }]);
    await expect(instance.diagnostics(plugin.manifest.id)).resolves.toMatchObject([{ code: 'provider.[redacted]', message: '[redacted]' }]);
    await instance.dispose(plugin.manifest.id);
    expect(dispose).toHaveBeenCalledOnce();
    expect(instance.getObservabilityProvider('otlp')).toBeUndefined();
    resolve.mockResolvedValue({ secret: 'second-private-token' });
    await instance.activate(plugin);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(instance.getObservabilityProvider('otlp')).not.toBe(provider);
  });

  it('registers one OTLP provider for both trace and metric capabilities and disposes it once', async () => {
    const network = vi.fn();
    const [plugin] = await configure({ endpoint, serviceName: 'afk', timeoutMs: 300_000, resourceAttributes: { region: 'test', workers: 2, enabled: true } }, { fetch: network });
    expect(plugin.manifest).toMatchObject({ id: 'observability.otlp', provides: ['observability.provider'], trusted: true });
    expect(getConfiguredCredentialDependencies(plugin)).toEqual([]);
    const instance = runtime();
    await instance.activate(plugin);
    const provider = instance.getObservabilityProvider('otlp') as OtlpObservabilityProvider;
    expect(provider).toBeInstanceOf(OtlpObservabilityProvider);
    expect(provider.capabilities).toMatchObject({ span: true, event: true, baggage: false, counter: true, gauge: true, histogram: true });
    expect(instance.listProviders('observability.provider')).toEqual(['otlp']);
    expect(instance.listProvidersForPlugin(plugin.manifest.id)).toEqual(['otlp']);
    const dispose = vi.spyOn(provider, 'dispose');
    await instance.dispose(plugin.manifest.id);
    await instance.close();
    expect(dispose).toHaveBeenCalledOnce();
    expect(instance.listProviders('observability.provider')).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it('exports traces and metrics over HTTP using configured credentials and resource attributes', async () => {
    const requests: { path: string; authorization?: string; contentType?: string; body: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ path: request.url!, authorization: request.headers.authorization, contentType: request.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Collector did not bind a TCP port');
    const instance = runtime();
    try {
      const [plugin] = await configure({
        endpoint: `http://127.0.0.1:${address.port}/collector`, serviceName: 'configured-afk',
        resourceAttributes: { region: 'test-region', workers: 2, enabled: true },
        headers: { Authorization: { env: 'COLLECTOR_TOKEN' } },
      }, { environment: { COLLECTOR_TOKEN: 'Bearer collector-secret' } });
      await instance.activate(plugin);
      const provider = instance.getObservabilityProvider('otlp') as TracerProvider & MetricsProvider;
      const context = { traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef' };
      await provider.startSpan('configured.span', context);
      await provider.addEvent(context, 'configured.event');
      await provider.endSpan!(context);
      await provider.record({ name: 'configured.metric', value: 7, attributes: { phase: 'test' } });
      await instance.dispose(plugin.manifest.id);
      expect(new Set(requests.map(request => request.path))).toEqual(new Set(['/collector/v1/traces', '/collector/v1/metrics']));
      expect(requests.every(request => request.authorization === 'Bearer collector-secret' && request.contentType?.startsWith('application/json'))).toBe(true);
      const traces = requests.find(request => request.path.endsWith('/v1/traces'))!;
      const metrics = requests.find(request => request.path.endsWith('/v1/metrics'))!;
      expect(traces.body).toMatchObject({ resourceSpans: expect.any(Array) });
      expect(metrics.body).toMatchObject({ resourceMetrics: expect.any(Array) });
      const bodies = JSON.stringify(requests.map(request => request.body));
      for (const value of ['configured-afk', 'test-region', 'configured.span', 'configured.event', 'configured.metric', 'phase']) expect(bodies).toContain(value);
    } finally {
      await instance.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe('generic builtin observability registration', () => {
  it('preserves the provider identity and lifecycle for every observability kind', async () => {
    const providers: (EventStoreProvider | EvidenceStoreProvider | TracerProvider | MetricsProvider)[] = [
      { id: 'events', capabilities: { append: true, read: true, verify: false }, append: vi.fn(), read: vi.fn() },
      { id: 'observability.evidence', capabilities: { put: true, get: true, classify: false }, put: vi.fn(), get: vi.fn() },
      { id: 'tracer', capabilities: { span: true, event: true, baggage: true }, startSpan: vi.fn(), addEvent: vi.fn() },
      { id: 'metrics', capabilities: { counter: true, gauge: true, histogram: true }, record: vi.fn() },
    ];
    const instance = runtime();
    for (const provider of providers) {
      const managed = {
        ...provider,
        health: vi.fn(async () => ({ status: 'degraded' as const, message: 'collector unavailable' })),
        doctor: vi.fn(async () => [{ check: 'ready', ok: true }, { check: 'export', ok: false, detail: 'retry later' }]),
        dispose: vi.fn(),
      };
      const plugins = createBuiltinCapabilityPlugins({ observability: [managed] });
      expect(plugins).toHaveLength(1);
      const [plugin] = plugins;
      expect(plugin.manifest.id).toBe(provider.id.startsWith('observability.') ? provider.id : `observability.${provider.id}`);
      expect(plugin.manifest.provides).toEqual(['observability.provider']);
      await instance.activate(plugin);
      expect(instance.getObservabilityProvider(provider.id)).toBe(managed);
      await expect(instance.health(plugin.manifest.id)).resolves.toMatchObject([{ status: 'degraded', message: 'collector unavailable' }]);
      await expect(instance.diagnostics(plugin.manifest.id)).resolves.toMatchObject([{ severity: 'warning', code: 'provider.export', message: 'retry later' }]);
      await instance.dispose(plugin.manifest.id);
      expect(managed.dispose).toHaveBeenCalledOnce();
      expect(instance.getObservabilityProvider(provider.id)).toBeUndefined();
    }
  });
});
