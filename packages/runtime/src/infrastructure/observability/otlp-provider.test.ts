import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricsProvider, TracerProvider } from '../../plugin-sdk/capabilities.js';
import type { FetchTransport } from '../providers/dependencies.js';
import { OtlpObservabilityProvider, type OtlpObservabilityProviderOptions } from './otlp-provider.js';

interface Capture {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let endpoint: string;
let captures: Capture[];
let providers: OtlpObservabilityProvider[];
let status: number;
let responseBody: string;
let contentType: string;
let holdResponse: boolean;
let requestArrived: Promise<void>;
let onRequest: () => void;

function provider(options: Partial<OtlpObservabilityProviderOptions> = {}): OtlpObservabilityProvider {
  const instance = new OtlpObservabilityProvider({ endpoint, ...options });
  providers.push(instance);
  return instance;
}

function payload(index = 0) {
  return JSON.parse(captures[index].body);
}

const context = { traceId: '12345678-1234-5678-9012-123456789012', spanId: 'ABCDEF0123456789' };

beforeEach(async () => {
  captures = [];
  providers = [];
  status = 200;
  responseBody = '{}';
  contentType = 'application/json';
  holdResponse = false;
  requestArrived = new Promise(resolve => { onRequest = resolve; });
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captures.push({ url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    onRequest();
    if (holdResponse) return;
    response.writeHead(status, { 'content-type': contentType });
    response.end(responseBody);
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local HTTP address');
  endpoint = `http://127.0.0.1:${address.port}/collector/base/`;
});

afterEach(async () => {
  await Promise.all(providers.map(instance => instance.dispose()));
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OtlpObservabilityProvider', () => {
  it('implements both SDK contracts and checks readiness without sending data', async () => {
    const instance = provider();
    const tracer: TracerProvider = instance;
    const metrics: MetricsProvider = instance;
    expect(tracer.id).toBe('otlp');
    expect(metrics.capabilities).toEqual({ span: true, event: true, baggage: false, counter: true, gauge: true, histogram: true });
    expect(await instance.health()).toEqual({ status: 'ok', message: 'OTLP ready; collector not contacted' });
    expect(await instance.doctor()).toEqual([
      { check: 'otlp-readiness', ok: true, detail: 'Endpoint and resource validated locally' },
      { check: 'otlp-last-export', ok: false, detail: 'No export attempted; collector not contacted' },
    ]);
    expect(captures).toEqual([]);
  });

  it('posts a completed OTLP JSON span with resource, parent, attributes, events, status and numeric enums', async () => {
    const transport = vi.fn<Parameters<FetchTransport>, ReturnType<FetchTransport>>((url, init) => fetch(url, init));
    const instance = provider({
      fetch: transport, serviceName: 'worker', headers: { authorization: 'Bearer local-test', 'content-type': 'text/plain' },
      resourceAttributes: { environment: 'test', replicas: 2, enabled: true, 'service.name': 'overridden' },
    });
    const child = { ...context, parentSpanId: '0123456789ABCDEF' };
    await instance.startSpan('run', child, { attributes: { attempt: 1, phase: 'start' } });
    await instance.addEvent(child, 'accepted', { attributes: { cached: false } });
    expect(captures).toHaveLength(0);
    await instance.endSpan(child, { attributes: { phase: 'end' }, error: true });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(captures[0].url).toBe('/collector/base/v1/traces');
    expect(captures[0].headers).toMatchObject({ 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer local-test' });
    const resource = payload().resourceSpans[0];
    expect(resource.resource.attributes).toEqual([
      { key: 'environment', value: { stringValue: 'test' } },
      { key: 'replicas', value: { doubleValue: 2 } },
      { key: 'enabled', value: { boolValue: true } },
      { key: 'service.name', value: { stringValue: 'worker' } },
    ]);
    const span = resource.scopeSpans[0].spans[0];
    expect(span).toMatchObject({
      traceId: '12345678123456789012123456789012', spanId: 'abcdef0123456789', parentSpanId: '0123456789abcdef',
      name: 'run', kind: 1, status: { code: 2 }, droppedEventsCount: 0,
      attributes: [{ key: 'attempt', value: { doubleValue: 1 } }, { key: 'phase', value: { stringValue: 'end' } }],
      events: [{ name: 'accepted', attributes: [{ key: 'cached', value: { boolValue: false } }] }],
    });
    expect(span).not.toHaveProperty('eventBytes');
    for (const time of [span.startTimeUnixNano, span.events[0].timeUnixNano, span.endTimeUnixNano]) expect(time).toMatch(/^\d{19}$/);
    expect(BigInt(span.events[0].timeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.events[0].timeUnixNano));
    expect((await instance.health()).status).toBe('ok');
    expect((await instance.doctor())[1]).toMatchObject({ ok: true, detail: 'Last OTLP export succeeded' });
  });

  it('normalizes arbitrary and zero IDs consistently and keys spans by trace and span', async () => {
    const instance = provider();
    const first = { traceId: 'work-item', spanId: '0000000000000000' };
    const second = { traceId: 'other-work-item', spanId: first.spanId, parentSpanId: 'parent' };
    await instance.startSpan('first', first);
    await instance.startSpan('second', second);
    await instance.addEvent(first, 'same identity');
    await instance.endSpan(first);
    await instance.endSpan(second);
    const span = payload().resourceSpans[0].scopeSpans[0].spans[0];
    const sibling = payload(1).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe(createHash('sha256').update(first.traceId).digest('hex').slice(0, 32));
    expect(span.spanId).toBe(createHash('sha256').update(first.spanId).digest('hex').slice(0, 16));
    expect(span.spanId).not.toBe('0000000000000000');
    expect(span.events).toHaveLength(1);
    expect(span).not.toHaveProperty('parentSpanId');
    expect(sibling.spanId).toBe(span.spanId);
    expect(sibling.parentSpanId).toMatch(/^[\da-f]{16}$/);
    expect(sibling.traceId).not.toBe(span.traceId);
    expect(span.status).toEqual({ code: 1 });
    await expect(instance.endSpan(first)).rejects.toThrow('not active');
  });

  it('uses preserved hex IDs as the same lookup key regardless of case', async () => {
    const instance = provider();
    const ids = { traceId: 'ABCDEF0123456789ABCDEF0123456789', spanId: 'FEDCBA9876543210' };
    await instance.startSpan('case', ids);
    await instance.endSpan({ traceId: ids.traceId.toLowerCase(), spanId: ids.spanId.toLowerCase() });
    expect(payload().resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({ traceId: ids.traceId.toLowerCase(), spanId: ids.spanId.toLowerCase() });
  });

  it('exports DELTA monotonic sums, gauges, and single-observation DELTA histograms', async () => {
    const instance = provider();
    await instance.record({ name: 'work.count', kind: 'counter', value: 2, attributes: { success: true } });
    await instance.record({ name: 'queue.depth', kind: 'gauge', value: -3 });
    await instance.record({ name: 'work.duration', kind: 'histogram', value: 4.5 });
    const metrics = captures.map((capture, index) => {
      expect(capture.url).toBe('/collector/base/v1/metrics');
      return payload(index).resourceMetrics[0].scopeMetrics[0].metrics[0];
    });
    expect(metrics[0]).toMatchObject({ name: 'work.count', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ asDouble: 2, attributes: [{ key: 'success', value: { boolValue: true } }] }] } });
    expect(metrics[1]).toMatchObject({ name: 'queue.depth', gauge: { dataPoints: [{ asDouble: -3 }] } });
    expect(metrics[1].gauge.dataPoints[0]).not.toHaveProperty('startTimeUnixNano');
    expect(metrics[2]).toMatchObject({ name: 'work.duration', histogram: { aggregationTemporality: 1, dataPoints: [{ count: '1', sum: 4.5, min: 4.5, max: 4.5, explicitBounds: [], bucketCounts: ['1'] }] } });
    for (const metric of metrics) {
      const point = (metric.sum ?? metric.gauge ?? metric.histogram).dataPoints[0];
      expect(point.timeUnixNano).toMatch(/^\d{19}$/);
      if (point.startTimeUnixNano) expect(BigInt(point.timeUnixNano)).toBeGreaterThan(BigInt(point.startTimeUnixNano));
    }
  });

  it('tracks DELTA start times separately for each attribute set and instrument', async () => {
    const instance = provider();
    await instance.record({ name: 'work.count', kind: 'counter', value: 1, attributes: { phase: 'first', ready: true } });
    await instance.record({ name: 'work.count', kind: 'counter', value: 1, attributes: { phase: 'second', ready: true } });
    await instance.record({ name: 'work.duration', kind: 'histogram', value: 5 });
    await instance.record({ name: 'work.count', kind: 'counter', value: 1, attributes: { ready: true, phase: 'first' } });
    const first = payload(0).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    const other = payload(1).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    const repeated = payload(3).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    expect(other.startTimeUnixNano).toBe(first.startTimeUnixNano);
    expect(repeated.startTimeUnixNano).toBe(first.timeUnixNano);
  });

  it('releases an unfinished span when its host export budget is aborted', async () => {
    const instance = provider();
    const controller = new AbortController();
    await instance.startSpan('cancelled', context, { signal: controller.signal });
    controller.abort();
    await instance.startSpan('replacement', context);
    await instance.endSpan(context);
    expect(payload().resourceSpans[0].scopeSpans[0].spans[0].name).toBe('replacement');
  });

  it('omits the histogram sum for negative observations', async () => {
    await provider().record({ name: 'temperature', kind: 'histogram', value: -2 });
    const point = payload().resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
    expect(point).toMatchObject({ count: '1', min: -2, max: -2, bucketCounts: ['1'] });
    expect(point).not.toHaveProperty('sum');
  });

  it('treats samples without an instrument kind as gauge observations', async () => {
    await provider().record({ name: 'temperature', value: -2 });
    expect(payload().resourceMetrics[0].scopeMetrics[0].metrics[0]).toMatchObject({
      name: 'temperature', gauge: { dataPoints: [{ asDouble: -2 }] },
    });
  });

  it.each([
    'ftp://collector', 'https://user:secret@collector', 'https://collector?secret=value',
    'https://collector#secret', 'https://collector?', 'https://collector#', '/relative', 'not a URL',
  ])('rejects invalid endpoints without echoing them: %s', invalid => {
    expect(() => provider({ endpoint: invalid })).toThrow('Invalid OTLP endpoint');
  });

  it('validates constructor inputs without exposing header values', () => {
    for (const timeoutMs of [0, -1, 0.1, Infinity, 300_001]) expect(() => provider({ timeoutMs })).toThrow('Invalid OTLP timeout');
    expect(() => provider({ serviceName: '' })).toThrow('Invalid OTLP service name');
    expect(() => provider({ headers: { authorization: 'secret\nvalue' } })).toThrow('Invalid OTLP headers');
    expect(() => provider({ resourceAttributes: { value: Infinity } })).toThrow('Invalid OTLP attribute value');
  });

  it('rejects invalid operation inputs before sending telemetry', async () => {
    const instance = provider();
    for (const value of [NaN, Infinity, -Infinity]) await expect(instance.record({ name: 'metric', value })).rejects.toThrow('metric value');
    await expect(instance.record({ name: 'metric', kind: 'counter', value: -1 })).rejects.toThrow('counter value');
    await expect(instance.record({ name: 'bad name', value: 1 })).rejects.toThrow('metric name');
    await expect(instance.record({ name: 'metric', value: 1, kind: 'invalid' as 'counter' })).rejects.toThrow('metric kind');
    await expect(instance.startSpan('', context)).rejects.toThrow('span name');
    await expect(instance.startSpan('span', { ...context, traceId: '' })).rejects.toThrow('identifier');
    await expect(instance.startSpan('span', { ...context, parentSpanId: context.spanId })).rejects.toThrow('parent span');
    await expect(instance.startSpan('span', context, { attributes: { value: [] as unknown as string } })).rejects.toThrow('attribute value');
    await expect(instance.record({ name: 'metric', value: 1, attributes: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, true])) })).rejects.toThrow('attribute limit');
    await instance.startSpan('valid', context);
    await expect(instance.startSpan('duplicate', context)).rejects.toThrow('already active');
    await expect(instance.addEvent({ ...context, spanId: 'unknown' }, 'event')).rejects.toThrow('not active');
    await expect(instance.endSpan(context, { error: 'secret' as unknown as boolean })).rejects.toThrow('span status');
    expect(captures).toHaveLength(0);
  });

  it('bounds active spans and event count, and releases span capacity on completion', async () => {
    const instance = provider();
    for (let index = 0; index < 1_024; index++) await instance.startSpan('span', { traceId: 'trace', spanId: String(index) });
    await expect(instance.startSpan('overflow', context)).rejects.toThrow('active span limit');
    const first = { traceId: 'trace', spanId: '0' };
    for (let index = 0; index < 130; index++) await instance.addEvent(first, 'event');
    await instance.endSpan(first);
    const span = payload().resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.events).toHaveLength(128);
    expect(span.droppedEventsCount).toBe(2);
    await expect(instance.startSpan('capacity freed', context)).resolves.toBeUndefined();
  });

  it('bounds event bytes and snapshots caller attributes and headers', async () => {
    const headers = { authorization: 'original' };
    const resourceAttributes = { environment: 'original' };
    const spanAttributes = { name: 'original' };
    const instance = provider({ headers, resourceAttributes });
    await instance.startSpan('span', context, { attributes: spanAttributes });
    headers.authorization = resourceAttributes.environment = spanAttributes.name = 'changed';
    for (let index = 0; index < 20; index++) await instance.addEvent(context, 'event', { attributes: { text: 'x'.repeat(4_096) } });
    await instance.endSpan(context);
    const resource = payload().resourceSpans[0];
    const span = resource.scopeSpans[0].spans[0];
    expect(span.events.length).toBeLessThan(20);
    expect(span.droppedEventsCount).toBe(20 - span.events.length);
    expect(span.attributes).toContainEqual({ key: 'name', value: { stringValue: 'original' } });
    expect(resource.resource.attributes).toContainEqual({ key: 'environment', value: { stringValue: 'original' } });
    expect(captures[0].headers.authorization).toBe('original');
  });

  it.each(['traces', 'metrics'] as const)('rejects %s partial failures without echoing collector diagnostics', async signal => {
    const instance = provider();
    responseBody = JSON.stringify({ partialSuccess: { [signal === 'traces' ? 'rejectedSpans' : 'rejectedDataPoints']: '1', errorMessage: 'SECRET collector detail' } });
    const operation = async () => {
      if (signal === 'metrics') return instance.record({ name: 'metric', value: 1 });
      await instance.startSpan('span', context);
      return instance.endSpan(context);
    };
    await expect(operation()).rejects.toThrow('OTLP collector rejected telemetry');
    const health = await instance.health();
    expect(health.status).toBe('degraded');
    expect(JSON.stringify(health)).not.toContain('SECRET');
    responseBody = '{}';
    if (signal === 'traces') await instance.record({ name: 'other-signal', value: 1 });
    else {
      await instance.startSpan('other-signal', context);
      await instance.endSpan(context);
    }
    expect((await instance.health()).status).toBe('degraded');
    expect((await instance.doctor())[1].ok).toBe(false);
    await operation();
    expect((await instance.health()).status).toBe('ok');
  });

  it.each([{}, { rejectedDataPoints: '0' }, { rejectedDataPoints: 0, errorMessage: 'warning' }])('accepts valid empty and warning partial successes: %j', async partialSuccess => {
    responseBody = JSON.stringify({ partialSuccess });
    await expect(provider().record({ name: 'metric', value: 1 })).resolves.toBeUndefined();
  });

  it.each([
    'SECRET invalid JSON', 'null', '[]', '{"partialSuccess":[]}',
    '{"partialSuccess":{"rejectedDataPoints":-1}}', '{"partialSuccess":{"rejectedDataPoints":1.5}}',
    '{"partialSuccess":{"rejectedDataPoints":"SECRET"}}', '{"partialSuccess":{"rejectedDataPoints":"9223372036854775808"}}',
    '{"partialSuccess":{"errorMessage":123}}',
  ])('rejects malformed collector JSON without echoing the body: %s', async body => {
    responseBody = body;
    const instance = provider();
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow(/OTLP/);
    expect(JSON.stringify(await instance.health())).not.toContain('SECRET');
    expect((await instance.health()).status).toBe('degraded');
  });

  it('rejects bad HTTP status, content type, redirect, and oversized bodies safely', async () => {
    const instance = provider();
    responseBody = 'SECRET error body';
    status = 503;
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('Provider HTTP request failed (503)');
    status = 202;
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('Invalid OTLP response status');
    status = 200;
    contentType = 'text/plain';
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('Invalid OTLP response content type');
    contentType = 'application/json';
    responseBody = 'x'.repeat(65_537);
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('Provider HTTP response exceeded limit');
    status = 302;
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow(/Provider HTTP/);
    expect(JSON.stringify(await instance.health())).not.toContain('SECRET');
  });

  it('sanitizes transport failures and caller abort reasons', async () => {
    const instance = provider({ fetch: async () => { throw new Error('SECRET transport endpoint'); } });
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('Provider HTTP transport failed');
    const abort = new AbortController();
    abort.abort(new Error('SECRET abort reason'));
    await expect(instance.record({ name: 'metric', value: 1 }, { signal: abort.signal })).rejects.toThrow('OTLP operation cancelled');
    expect(captures).toHaveLength(0);
  });

  it('cancels a live HTTP export on caller abort', async () => {
    holdResponse = true;
    const instance = provider();
    const abort = new AbortController();
    const pending = expect(instance.record({ name: 'metric', value: 1 }, { signal: abort.signal })).rejects.toThrow('OTLP operation cancelled');
    await requestArrived;
    abort.abort(new Error('SECRET abort reason'));
    await pending;
    expect((await instance.health()).status).toBe('degraded');
  });

  it('times out a live HTTP export', async () => {
    holdResponse = true;
    const instance = provider({ timeoutMs: 50 });
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('Provider HTTP request timed out');
  });

  it('bounds concurrent exports and disposal aborts them and rejects all new work', async () => {
    const signals: AbortSignal[] = [];
    const instance = provider({ fetch: async (_url, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => undefined);
    } });
    await instance.startSpan('span', context);
    const pending = Array.from({ length: 32 }, () => expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('OTLP provider disposed'));
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('concurrent export limit');
    await expect(instance.endSpan(context)).rejects.toThrow('concurrent export limit');
    expect(signals).toHaveLength(32);
    await instance.dispose();
    await Promise.all(pending);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    await instance.dispose();
    for (const operation of [
      instance.startSpan('span', context), instance.addEvent(context, 'event'), instance.endSpan(context), instance.record({ name: 'metric', value: 1 }),
    ]) await expect(operation).rejects.toThrow('OTLP provider disposed');
    expect((await instance.health()).status).toBe('unavailable');
    expect((await instance.doctor())[0].ok).toBe(false);
  });

  it('reports a missing local transport without probing a collector', async () => {
    vi.stubGlobal('fetch', undefined);
    const instance = provider();
    expect((await instance.health()).status).toBe('unavailable');
    expect((await instance.doctor())[0]).toMatchObject({ ok: false, detail: 'OTLP HTTP transport unavailable' });
    await expect(instance.record({ name: 'metric', value: 1 })).rejects.toThrow('transport unavailable');
    expect(captures).toHaveLength(0);
  });
});
