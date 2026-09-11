import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { logger } from '../infrastructure/io/logger';
import type { ObservationContext, RunEventData, RunEventDraft } from '../core/events';
import type { AppendReceipt, ClockPort, EventStorePort, IdPort, MetricsPort, TracerPort } from '../core/ports';

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
  tracer?: TracerPort;
  metrics?: MetricsPort;
  clock?: ClockPort;
  ids?: IdPort;
  log?: Logger;
}

/**
 * The single migration seam for existing runners. It records audit facts before
 * reporting success to callers, and makes missing event persistence observable.
 */
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
    return this.tracer.within(`afk.${data.kind}`, context, async () => {
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
      const fields = contextLogFields(context);
      this.log.info({ ...fields, event_type: data.kind, event_sequence: receipt.lastSequence }, 'run event persisted');
      this.metrics.counter('afk.run_events_total', 1, {
        event_type: data.kind,
        profile_id: context.profileId,
        actor_kind: context.actor.kind,
      });
      this.tracer.addEvent(context, data.kind, { event_sequence: receipt.lastSequence });
      return receipt;
    });
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
