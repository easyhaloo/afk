import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import { logger, withLogWriteFailureObserver } from '../infrastructure/io/logger.js';
import type { ObservationContext, RunEventData, RunEventDraft, AppendReceipt, ClockPort, EventStorePort, IdPort, MetricsPort, TracerPort } from '@afk/core';

type DeliverySignal = 'events' | 'tracing' | 'metrics' | 'logging';
type DeliveryOutcome = 'succeeded' | 'failed' | 'timed_out' | 'dropped' | 'skipped';
type CaptureFailure = 'failed' | 'timed_out' | 'cancelled';
const deliveryScope = new AsyncLocalStorage<{
  counts: Record<DeliverySignal, Record<DeliveryOutcome, number>>;
  evidenceCaptureFailures: Record<CaptureFailure, number>;
}>();

/** Fixed labels only; provider IDs, errors and payloads never become dimensions. */
export function recordObservationDelivery(signal: DeliverySignal, outcome: DeliveryOutcome): void {
  const counts = deliveryScope.getStore()?.counts[signal];
  if (counts) counts[outcome] = Math.min(Number.MAX_SAFE_INTEGER, counts[outcome] + 1);
}

/** Capture precedes SDK invocation; never count a failed capture as an export attempt. */
export function recordEvidenceCaptureFailure(outcome: CaptureFailure): void {
  const counts = deliveryScope.getStore()?.evidenceCaptureFailures;
  if (counts) counts[outcome] = Math.min(Number.MAX_SAFE_INTEGER, counts[outcome] + 1);
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdPort {
  next(): string {
    return randomUUID();
  }
}

export class NoopTracer implements TracerPort {
  async within<T>(_name: string, _context: ObservationContext, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  addEvent(_context: ObservationContext, _name: string, _attributes?: Readonly<Record<string, string | number | boolean>>): void {
    // The first migration stage remains useful without an OTLP backend.
  }
}

export class NoopMetrics implements MetricsPort {
  counter(_name: string, _value: number, _attributes?: Readonly<Record<string, string | number | boolean>>): void {}
  histogram(_name: string, _value: number, _attributes?: Readonly<Record<string, string | number | boolean>>): void {}
  gauge(_name: string, _value: number, _attributes?: Readonly<Record<string, string | number | boolean>>): void {}
}

export interface RunObserverDependencies {
  events: EventStorePort;
  /** Authoritative append bypassing export, evidence capture and derived intake. */
  auditEvents?: Pick<EventStorePort, 'append'>;
  tracer?: TracerPort;
  metrics?: MetricsPort;
  clock?: ClockPort;
  ids?: IdPort;
  log?: Logger;
  onPersisted?: (draft: RunEventDraft, receipt: AppendReceipt) => Promise<void>;
}

/** Records audit facts before reporting success to callers. */
export class RunObserver {
  private readonly tracer: TracerPort;
  private readonly metrics: MetricsPort;
  private readonly clock: ClockPort;
  private readonly ids: IdPort;
  private readonly log: Logger;

  constructor(private readonly deps: RunObserverDependencies) {
    this.tracer = deps.tracer ?? new NoopTracer();
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.clock = deps.clock ?? new SystemClock();
    this.ids = deps.ids ?? new UuidGenerator();
    this.log = deps.log ?? logger;
  }

  async record<T extends RunEventData>(context: ObservationContext, data: T, options: {
    causationId?: string;
    idempotencyKey?: string;
    evidence?: RunEventDraft<T>['evidence'];
  } = {}): Promise<AppendReceipt> {
    const started = performance.now();
    const empty = () => ({ succeeded: 0, failed: 0, timed_out: 0, dropped: 0, skipped: 0 });
    const counts = { events: empty(), tracing: empty(), metrics: empty(), logging: empty() };
    const evidenceCaptureFailures = { failed: 0, timed_out: 0, cancelled: 0 };
    let dayRotatorWriteFailures = 0;
    return deliveryScope.run({ counts, evidenceCaptureFailures }, () => withLogWriteFailureObserver(() => {
      recordObservationDelivery('logging', 'failed');
      dayRotatorWriteFailures = Math.min(Number.MAX_SAFE_INTEGER, dayRotatorWriteFailures + 1);
    }, async () => {
      let source: RunEventDraft | undefined;
      const receipt = await this.tracer.within(`afk.${data.kind}`, context, async () => {
        const occurredAt = this.clock.now().toISOString();
        const draft: RunEventDraft<T> = {
          id: this.ids.next(),
          schemaVersion: 1,
          type: data.kind,
          occurredAt,
          context,
          causationId: options.causationId,
          correlationId: context.runId,
          idempotencyKey: options.idempotencyKey,
          data,
          evidence: options.evidence,
        };
        const receipt = await this.deps.events.append([draft]);
        source = { ...draft, context: { ...draft.context, actor: { ...draft.context.actor } } };
        const fields = contextLogFields(context);
        // Call throws and native day-log failures are observed separately; async transports are unknown.
        try {
          this.log.info({ ...fields, event_type: data.kind, event_sequence: receipt.lastSequence }, 'run event persisted');
        } catch { recordObservationDelivery('logging', 'failed'); }
        this.metrics.counter('afk.run_events_total', 1, {
          event_type: data.kind,
          profile_id: context.profileId,
          actor_kind: context.actor.kind,
        });
        this.tracer.addEvent(context, data.kind, { event_sequence: receipt.lastSequence });
        this.metrics.histogram('run.event_persistence_ms', performance.now() - started, { event_type: data.kind });
        try {
          await this.deps.onPersisted?.(draft, receipt);
        } catch {
          try {
            this.log.warn({ ...fields, event_type: data.kind, code: 'derived_intake_failed' }, 'Derived intake failed; local audit remains available for recovery');
          } catch { recordObservationDelivery('logging', 'failed'); }
        }
        return receipt;
      });
      if (source && (Object.values(counts).some(value => value.failed || value.timed_out || value.dropped || value.skipped)
        || Object.values(evidenceCaptureFailures).some(value => value > 0))) {
        const idempotencyKey = `${source.id}:observability.delivery`;
        // One bounded local summary per degraded record; never re-export or learn it.
        // A local append failure remains fatal and retains its original error.
        await (this.deps.auditEvents ?? this.deps.events).append([{
          id: this.ids.next(), schemaVersion: 1, type: 'effect.completed', occurredAt: this.clock.now().toISOString(),
          context: source.context, correlationId: source.correlationId, causationId: source.id, idempotencyKey,
          data: { kind: 'effect.completed', effectKind: 'observability.delivery', idempotencyKey,
            outcome: 'failed', summary: JSON.stringify({ version: 1, sourceEventId: source.id,
              sourceSequence: receipt.lastSequence, retry: 'none', boundary: 'provider_promise_sync_logger_throw_and_day_rotator_write_failure',
              dayRotatorWriteFailures, evidenceCaptureFailures, counts }) },
        }]);
      }
      return receipt;
    }));
  }
}

export function loggerFor(context: ObservationContext, base: Logger = logger): Logger {
  return base.child(contextLogFields(context));
}

export function contextLogFields(context: ObservationContext): Record<string, string | number | undefined> {
  return {
    trace_id: context.traceId,
    span_id: context.spanId,
    run_id: context.runId,
    work_item_id: context.workItemId,
    profile_id: context.profileId,
    attempt: context.attempt,
    lease_epoch: context.leaseEpoch,
    actor_kind: context.actor.kind,
    actor_id: context.actor.id,
  };
}
