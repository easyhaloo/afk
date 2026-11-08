import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { EventStorePort, MetricsPort, TracerPort } from '@afk/core';
import type { EventStoreProvider, MetricsProvider, TracerProvider, TraceContext, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { logger } from '../io/logger.js';
import { JsonlEventStore } from './jsonl-event-store.js';
import { RunObserver } from '../../observability/run-observer.js';
import { captureEventEvidence, createArtifactAudit, type ArtifactAuditOptions } from './artifact-audit.js';

type ObservationProvider = Partial<EventStoreProvider & MetricsProvider & TracerProvider>;
export interface ObservabilityProviderSelection {
  readonly provider: object;
  readonly signals: readonly ('events' | 'tracing' | 'metrics')[];
}
type ExportScope = { context: TraceContext; pending: Promise<void>; controller: AbortController; deadline: number };

export interface RunObserverOptions {
  readonly artifacts?: ArtifactAuditOptions;
}

export function createRunObserver(root = process.env.AFK_EVENT_STORE_DIR, providers: readonly ObservabilityProviderSelection[] = [], options: RunObserverOptions = {}): RunObserver {
  const events = new JsonlEventStore({ root });
  if (!providers.length && !options.artifacts?.provider.capabilities.write) return new RunObserver({ events });
  const providersFor = (signal: ObservabilityProviderSelection['signals'][number]) => [...new Set(providers.filter(entry => entry.signals.includes(signal)).map(entry => entry.provider))] as ObservationProvider[];
  const tracers = providersFor('tracing');
  const metricsProviders = providersFor('metrics');
  const eventStores = providersFor('events');
  const scopes = new AsyncLocalStorage<ExportScope>();
  const warned = new Set<ObservationProvider>();
  const enqueue = (provider: ObservationProvider, operation: (options: ProviderOperationOptions) => Promise<void>) => {
    const scope = scopes.getStore();
    if (!scope) return;
    scope.pending = scope.pending.then(async () => {
      if (scope.controller.signal.aborted) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = scope.deadline - performance.now();
        if (remaining <= 0) {
          scope.controller.abort();
          throw new Error('Observability export timed out');
        }
        await Promise.race([
          Promise.resolve().then(() => operation({ signal: scope.controller.signal })),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              scope.controller.abort();
              reject(new Error('Observability export timed out'));
            }, remaining);
          }),
        ]);
      } catch {
        if (!warned.has(provider)) {
          warned.add(provider);
          logger.warn({ provider_id: provider.id }, 'Observability export failed; local audit remains authoritative');
        }
      } finally {
        clearTimeout(timer);
      }
    });
  };
  const tracer: TracerPort = {
    async within(name, context, operation) {
      const scope: ExportScope = {
        context: { traceId: context.traceId, spanId: randomBytes(8).toString('hex'), parentSpanId: context.spanId },
        pending: Promise.resolve(),
        controller: new AbortController(), deadline: performance.now() + 5_000,
      };
      return scopes.run(scope, async () => {
        const activeTracers = tracers.filter(provider => provider.capabilities?.span && typeof provider.startSpan === 'function');
        for (const provider of activeTracers) enqueue(provider, options => provider.startSpan!(name, scope.context, {
          ...options, attributes: { run_id: context.runId, work_item_id: context.workItemId, profile_id: context.profileId, attempt: context.attempt, actor_kind: context.actor.kind },
        }));
        let failed = true;
        try {
          const result = await operation();
          failed = false;
          return result;
        } finally {
          for (const provider of activeTracers) {
            if (typeof provider.endSpan === 'function') enqueue(provider, options => provider.endSpan!(scope.context, { ...options, error: failed }));
          }
          await scope.pending;
        }
      });
    },
    addEvent(_context, name, attributes) {
      const scope = scopes.getStore();
      if (!scope) return;
      for (const provider of tracers) {
        if (provider.capabilities?.event && typeof provider.addEvent === 'function') {
          enqueue(provider, options => provider.addEvent!(scope.context, name, { ...options, attributes }));
        }
      }
    },
  };
  const sample = (kind: 'counter' | 'histogram' | 'gauge', name: string, value: number, attributes?: Readonly<Record<string, string | number | boolean>>) => {
    for (const provider of metricsProviders) {
      if (provider.capabilities?.[kind] && typeof provider.record === 'function') {
        enqueue(provider, options => provider.record!({ name, value, kind, attributes }, options));
      }
    }
  };
  const metrics: MetricsPort = {
    counter: (name, value, attributes) => sample('counter', name, value, attributes),
    histogram: (name, value, attributes) => sample('histogram', name, value, attributes),
    gauge: (name, value, attributes) => sample('gauge', name, value, attributes),
  };
  const mirroredEvents: EventStorePort = {
    async append(drafts) {
      const receipt = await events.append(drafts);
      for (const provider of eventStores) {
        if (provider.capabilities?.append && typeof provider.append === 'function') enqueue(provider, options => provider.append!(drafts.map((draft, index) => ({
          runId: draft.context.runId, sequence: receipt.firstSequence + index, type: draft.type,
          payload: { id: draft.id, data: draft.data, context: draft.context, occurredAt: draft.occurredAt, causationId: draft.causationId, evidence: draft.evidence },
        })), options));
      }
      return receipt;
    },
    read: (runId, options) => events.read(runId, options),
    listRuns: () => events.listRuns(),
    verify: runId => events.verify(runId),
  };
  const auditArtifacts = createArtifactAudit(mirroredEvents, options.artifacts);
  return new RunObserver({ events: {
    ...mirroredEvents,
    async append(drafts) {
      const captured = await Promise.all(drafts.map(draft => captureEventEvidence(draft, options.artifacts)));
      const receipt = await mirroredEvents.append(captured);
      if (auditArtifacts) {
        for (const [index, draft] of captured.entries()) await auditArtifacts(draft, receipt.firstSequence + index);
      }
      return receipt;
    },
  }, tracer, metrics });
}
