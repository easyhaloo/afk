import { createHash } from 'node:crypto';
import type {
  MetricSample,
  MetricsProvider,
  ProviderDiagnostic,
  ProviderHealth,
  ProviderOperationOptions,
  TraceContext,
  TraceSpanOptions,
  TracerProvider,
} from '../../plugin-sdk/capabilities.js';
import { requestHttp, type FetchTransport } from '../providers/dependencies.js';

type Attributes = Readonly<Record<string, string | number | boolean>>;
type Attribute = { key: string; value: { stringValue: string } | { doubleValue: number } | { boolValue: boolean } };
type SpanEvent = { name: string; timeUnixNano: string; attributes: Attribute[] };

export interface OtlpObservabilityProviderOptions {
  readonly endpoint: string;
  readonly serviceName?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly resourceAttributes?: Attributes;
  readonly fetch?: FetchTransport;
}

interface ActiveSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  attributes: Attribute[];
  events: SpanEvent[];
  droppedEventsCount: number;
  eventBytes: number;
  removeAbortListener?: () => void;
}

const MAX_SPANS = 1_024;
const MAX_EVENTS = 128;
const MAX_EXPORTS = 32;
const MAX_ATTRIBUTES = 128;
const MAX_ATTRIBUTE_BYTES = 16_384;
const MAX_EVENT_BYTES = 65_536;

function text(value: unknown, label: string, maxLength = 1_024): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
    throw new Error(`Invalid OTLP ${label}`);
  }
}

function attributes(input?: Attributes): Attribute[] {
  if (input === undefined) return [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid OTLP attributes');
  const entries = Object.entries(input);
  if (entries.length > MAX_ATTRIBUTES) throw new Error('OTLP attribute limit exceeded');
  const encoded = entries.map(([key, value]): Attribute => {
    text(key, 'attribute key', 256);
    if (typeof value === 'string' && value.length <= 4_096) return { key, value: { stringValue: value } };
    if (typeof value === 'number' && Number.isFinite(value)) return { key, value: { doubleValue: value } };
    if (typeof value === 'boolean') return { key, value: { boolValue: value } };
    throw new Error('Invalid OTLP attribute value');
  });
  if (Buffer.byteLength(JSON.stringify(encoded)) > MAX_ATTRIBUTE_BYTES) throw new Error('OTLP attribute limit exceeded');
  return encoded;
}

function mergeAttributes(initial: Attribute[], extra: Attribute[]): Attribute[] {
  const merged = [...new Map([...initial, ...extra].map(attribute => [attribute.key, attribute])).values()];
  if (merged.length > MAX_ATTRIBUTES || Buffer.byteLength(JSON.stringify(merged)) > MAX_ATTRIBUTE_BYTES) {
    throw new Error('OTLP attribute limit exceeded');
  }
  return merged;
}

function identifier(input: unknown, length: number): string {
  text(input, 'identifier', 4_096);
  const compact = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input) ? input.replaceAll('-', '') : input;
  if (new RegExp(`^[\\da-f]{${length}}$`, 'i').test(compact) && !/^0+$/.test(compact)) return compact.toLowerCase();
  const hashed = createHash('sha256').update(input).digest('hex').slice(0, length);
  return /^0+$/.test(hashed) ? `${'0'.repeat(length - 1)}1` : hashed;
}

function contextIds(context: TraceContext): { traceId: string; spanId: string; parentSpanId?: string } {
  if (!context || typeof context !== 'object') throw new Error('Invalid OTLP trace context');
  const traceId = identifier(context.traceId, 32);
  const spanId = identifier(context.spanId, 16);
  const parentSpanId = context.parentSpanId === undefined ? undefined : identifier(context.parentSpanId, 16);
  if (spanId === parentSpanId) throw new Error('Invalid OTLP parent span identifier');
  return { traceId, spanId, ...(parentSpanId === undefined ? {} : { parentSpanId }) };
}

function validateResponse(body: string, rejectedField: string): void {
  let response: unknown;
  try { response = JSON.parse(body); } catch { throw new Error('OTLP response is not valid JSON'); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid OTLP response');
  if (!('partialSuccess' in response)) return;
  const partial = response.partialSuccess;
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error('Invalid OTLP partial success');
  const count: unknown = (partial as { readonly [key: string]: unknown })[rejectedField] ?? 0;
  if (!(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    && !(typeof count === 'string' && /^\d{1,19}$/.test(count) && BigInt(count) <= 9_223_372_036_854_775_807n)) {
    throw new Error('Invalid OTLP rejection count');
  }
  if ('errorMessage' in partial && typeof partial.errorMessage !== 'string') throw new Error('Invalid OTLP partial success');
  if (BigInt(count) > 0n) throw new Error('OTLP collector rejected telemetry');
}

export class OtlpObservabilityProvider implements TracerProvider, MetricsProvider {
  readonly id = 'otlp';
  readonly capabilities = { span: true, event: true, baggage: false, counter: true, gauge: true, histogram: true } as const;
  private readonly endpoint: string;
  private readonly headers: Headers;
  private readonly resource: { attributes: Attribute[] };
  private readonly timeoutMs: number;
  private readonly transport?: FetchTransport;
  private readonly spans = new Map<string, ActiveSpan>();
  private readonly exports = new Set<AbortController>();
  private readonly clockOrigin = process.hrtime.bigint();
  private readonly unixOrigin = BigInt(Date.now()) * 1_000_000n;
  private readonly metricStarts = new Map<string, bigint>();
  private disposed = false;
  private lastExport?: { ok: boolean; message: string };
  private readonly signalExports = new Map<'traces' | 'metrics', { ok: boolean; message: string }>();

  constructor(options: OtlpObservabilityProviderOptions) {
    text(options?.endpoint, 'endpoint', 8_192);
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); } catch { throw new Error('Invalid OTLP endpoint'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || options.endpoint.includes('?') || options.endpoint.includes('#')) throw new Error('Invalid OTLP endpoint');
    this.endpoint = endpoint.href.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs === undefined ? 2_000 : options.timeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 300_000) {
      throw new Error('Invalid OTLP timeout');
    }
    if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new Error('Invalid OTLP transport');
    this.transport = options.fetch;
    const serviceName = options.serviceName === undefined ? 'runtime' : options.serviceName;
    text(serviceName, 'service name');
    this.resource = { attributes: mergeAttributes(attributes(options.resourceAttributes), attributes({ 'service.name': serviceName })) };
    try {
      if (options.headers !== undefined && (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers))) {
        throw new Error();
      }
      const entries = Object.entries(options.headers ?? {});
      if (entries.length > 64 || entries.some(([key, value]) => typeof value !== 'string' || key.length + value.length > 8_192)) throw new Error();
      this.headers = new Headers(entries);
      this.headers.set('content-type', 'application/json');
      this.headers.set('accept', 'application/json');
    } catch { throw new Error('Invalid OTLP headers'); }
  }

  async startSpan(name: string, context: TraceContext, options?: TraceSpanOptions): Promise<void> {
    this.ready(options);
    text(name, 'span name');
    const ids = contextIds(context);
    const key = `${ids.traceId}:${ids.spanId}`;
    if (this.spans.has(key)) throw new Error('OTLP span already active');
    if (this.spans.size >= MAX_SPANS) throw new Error('OTLP active span limit exceeded');
    this.spans.set(key, {
      ...ids, name, kind: 1, startTimeUnixNano: this.now().toString(), attributes: attributes(options?.attributes),
      events: [], droppedEventsCount: 0, eventBytes: 0,
    });
    if (options?.signal) {
      const signal = options.signal;
      const span = this.spans.get(key)!;
      const abort = () => {
        this.spans.delete(key);
        span.removeAbortListener?.();
      };
      span.removeAbortListener = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  }

  async addEvent(context: TraceContext, name: string, options?: TraceSpanOptions): Promise<void> {
    this.ready(options);
    text(name, 'event name');
    const span = this.activeSpan(context);
    const event = { name, timeUnixNano: this.now().toString(), attributes: attributes(options?.attributes) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (span.events.length >= MAX_EVENTS || span.eventBytes + bytes > MAX_EVENT_BYTES) {
      span.droppedEventsCount = Math.min(4_294_967_295, span.droppedEventsCount + 1);
      return;
    }
    span.events.push(event);
    span.eventBytes += bytes;
  }

  async endSpan(context: TraceContext, options?: TraceSpanOptions & { readonly error?: boolean }): Promise<void> {
    this.ready(options);
    if (options?.error !== undefined && typeof options.error !== 'boolean') throw new Error('Invalid OTLP span status');
    const { eventBytes: _eventBytes, removeAbortListener, ...span } = this.activeSpan(context);
    const exported = {
      ...span, attributes: mergeAttributes(span.attributes, attributes(options?.attributes)),
      endTimeUnixNano: this.now().toString(), status: { code: options?.error ? 2 : 1 },
    };
    if (this.exports.size >= MAX_EXPORTS) throw new Error('OTLP concurrent export limit exceeded');
    removeAbortListener?.();
    this.spans.delete(`${span.traceId}:${span.spanId}`);
    await this.export('traces', { resourceSpans: [{ resource: this.resource, scopeSpans: [{ scope: { name: 'observability' }, spans: [exported] }] }] }, options);
  }

  async record(sample: MetricSample, options?: ProviderOperationOptions): Promise<void> {
    this.ready(options);
    if (!sample || typeof sample !== 'object') throw new Error('Invalid OTLP metric sample');
    text(sample.name, 'metric name', 255);
    if (!/^[a-zA-Z][a-zA-Z\d_.\-/]*$/.test(sample.name)) throw new Error('Invalid OTLP metric name');
    if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)) throw new Error('Invalid OTLP metric value');
    const kind = sample.kind === undefined ? 'gauge' : sample.kind;
    if (!['counter', 'gauge', 'histogram'].includes(kind)) throw new Error('Invalid OTLP metric kind');
    if (kind === 'counter' && sample.value < 0) throw new Error('Invalid OTLP counter value');
    const encodedAttributes = attributes(sample.attributes);
    const time = this.now();
    const stream = JSON.stringify([sample.name, kind, [...encodedAttributes].sort((left, right) => left.key.localeCompare(right.key))]);
    const point = { attributes: encodedAttributes, startTimeUnixNano: (this.metricStarts.get(stream) ?? this.unixOrigin).toString(), timeUnixNano: time.toString() };
    const metric = kind === 'gauge'
      ? { name: sample.name, gauge: { dataPoints: [{ attributes: encodedAttributes, timeUnixNano: time.toString(), asDouble: sample.value }] } }
      : kind === 'counter'
        ? { name: sample.name, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ ...point, asDouble: sample.value }] } }
        : { name: sample.name, histogram: { aggregationTemporality: 1, dataPoints: [{
          ...point, count: '1', ...(sample.value >= 0 ? { sum: sample.value } : {}),
          min: sample.value, max: sample.value, explicitBounds: [], bucketCounts: ['1'],
        }] } };
    if (this.exports.size >= MAX_EXPORTS) throw new Error('OTLP concurrent export limit exceeded');
    if (kind !== 'gauge') {
      if (!this.metricStarts.has(stream) && this.metricStarts.size >= 1_024) this.metricStarts.delete(this.metricStarts.keys().next().value!);
      this.metricStarts.set(stream, time);
    }
    await this.export('metrics', { resourceMetrics: [{ resource: this.resource, scopeMetrics: [{ scope: { name: 'observability' }, metrics: [metric] }] }] }, options);
  }

  async health(options?: ProviderOperationOptions): Promise<ProviderHealth> {
    this.checkCancellation(options);
    if (this.disposed) return { status: 'unavailable', message: 'OTLP provider disposed' };
    if (!this.transport && typeof globalThis.fetch !== 'function') return { status: 'unavailable', message: 'OTLP HTTP transport unavailable' };
    const outcome = this.exportStatus();
    return { status: outcome?.ok === false ? 'degraded' : 'ok', message: outcome?.message ?? 'OTLP ready; collector not contacted' };
  }

  async doctor(options?: ProviderOperationOptions): Promise<readonly ProviderDiagnostic[]> {
    const health = await this.health(options);
    return [
      { check: 'otlp-readiness', ok: health.status !== 'unavailable', detail: health.status === 'unavailable' ? health.message : 'Endpoint and resource validated locally' },
      { check: 'otlp-last-export', ok: this.exportStatus()?.ok ?? false, detail: this.exportStatus()?.message ?? 'No export attempted; collector not contacted' },
    ];
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const span of this.spans.values()) span.removeAbortListener?.();
    this.spans.clear();
    this.metricStarts.clear();
    for (const controller of this.exports) controller.abort(new Error('OTLP provider disposed'));
    this.exports.clear();
  }

  private now(): bigint {
    return this.unixOrigin + process.hrtime.bigint() - this.clockOrigin;
  }

  private exportStatus() {
    return [...this.signalExports.values()].find(outcome => !outcome.ok) ?? this.lastExport;
  }

  private checkCancellation(options?: ProviderOperationOptions): void {
    if (options?.signal?.aborted) throw new Error('OTLP operation cancelled');
  }

  private ready(options?: ProviderOperationOptions): void {
    if (this.disposed) throw new Error('OTLP provider disposed');
    this.checkCancellation(options);
    if (!this.transport && typeof globalThis.fetch !== 'function') throw new Error('OTLP HTTP transport unavailable');
  }

  private activeSpan(context: TraceContext): ActiveSpan {
    const ids = contextIds(context);
    const span = this.spans.get(`${ids.traceId}:${ids.spanId}`);
    if (!span) throw new Error('OTLP span is not active');
    return span;
  }

  private async export(signal: 'traces' | 'metrics', body: unknown, options?: ProviderOperationOptions): Promise<void> {
    const controller = new AbortController();
    this.exports.add(controller);
    try {
      const response = await requestHttp(this.transport, `${this.endpoint}/v1/${signal}`, {
        method: 'POST', headers: this.headers, body: JSON.stringify(body), signal: controller.signal,
      }, { ...options, timeoutMs: this.timeoutMs, maxResponseBytes: 65_536 });
      if (response.status !== 200) throw new Error('Invalid OTLP response status');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Invalid OTLP response content type');
      const responseBody = await response.text();
      this.ready(options);
      validateResponse(responseBody, signal === 'traces' ? 'rejectedSpans' : 'rejectedDataPoints');
      this.lastExport = { ok: true, message: 'Last OTLP export succeeded' };
      this.signalExports.set(signal, this.lastExport);
    } catch (error) {
      const message = this.disposed ? 'OTLP provider disposed' : options?.signal?.aborted ? 'OTLP operation cancelled'
        : error instanceof Error && /^(?:Invalid OTLP (?:response(?: status| content type)?|partial success|rejection count)|OTLP response is not valid JSON|OTLP collector rejected telemetry|Provider HTTP (?:request timed out|request failed \(\d+\)|response exceeded limit|transport failed))$/.test(error.message)
          ? error.message : 'OTLP export failed';
      this.lastExport = { ok: false, message };
      this.signalExports.set(signal, this.lastExport);
      throw new Error(message);
    } finally {
      this.exports.delete(controller);
    }
  }
}
