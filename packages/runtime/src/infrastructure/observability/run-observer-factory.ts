import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EvidenceRef, EventStorePort, MetricsPort, RunEventDraft, TracerPort } from '@afk/core';
import type { ArtifactSink, EvidenceStoreProvider, EventStoreProvider, MetricsProvider, TracerProvider, TraceContext, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { logger } from '../io/logger.js';
import { JsonlEventStore } from './jsonl-event-store.js';
import { RunObserver, type RunObserverDependencies } from '../../observability/run-observer.js';
import { captureEventEvidence, createArtifactAudit, type ArtifactAuditOptions } from './artifact-audit.js';
import { redactUtf8 } from './local-evidence-store.js';
import { parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';

export const evidenceStoreSelectionSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  scopes: z.array(z.string().max(512).refine(value => {
    try {
      const scope = parseCanonicalProject(value);
      return `${scope.platform}:${scope.projectKey}` === value;
    } catch { return false; }
  })).min(1).max(32).refine(values => new Set(values).size === values.length),
  timeoutMs: z.number().int().positive().max(60_000).default(2_000),
  maxBytes: z.number().int().positive().max(1024 * 1024).default(64 * 1024),
}).strict();

export interface EvidenceMirrorOptions {
  readonly provider: EvidenceStoreProvider;
  readonly scopes: readonly string[];
  readonly evidence: Required<ArtifactAuditOptions['evidence']>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
  readonly onFailure?: (code: string) => void;
}

type ObservationProvider = Partial<EventStoreProvider & MetricsProvider & TracerProvider>;
export interface ObservabilityProviderSelection {
  readonly provider: object;
  readonly signals: readonly ('events' | 'tracing' | 'metrics')[];
}
type ExportScope = { context: TraceContext; pending: Promise<void>; controller: AbortController; deadline: number };

export interface RunObserverOptions {
  readonly artifacts?: ArtifactAuditOptions;
  readonly evidenceStore?: EvidenceMirrorOptions;
  readonly onPersisted?: RunObserverDependencies['onPersisted'];
}

async function prepareEvidenceMirror(source: RunEventDraft, options: EvidenceMirrorOptions & { readonly timeoutMs: number; readonly maxBytes: number }) {
  let scope: string;
  try {
    const identity = parseWorkItemId(source.context.workItemId);
    scope = `${identity.platform}:${identity.projectKey}`;
    if (!options.scopes.includes(scope) || options.isCurrent?.() === false) return { source };
  } catch { return { source }; }
  let ref: EvidenceRef | undefined;
  let recordId: string | undefined;
  let exportedHash: string | undefined;
  const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const sink: ArtifactSink = {
    id: 'sdk-evidence', capabilities: { write: true, read: false, list: false },
    async put(artifact, operation) {
      if (operation?.signal?.aborted) throw new Error('Evidence mirror cancelled');
      if (!ref || options.isCurrent?.() === false) throw new Error('Evidence mirror is not authorized');
      const bytes = Buffer.from(artifact.bytes);
      exportedHash = digest(bytes);
      recordId = digest(JSON.stringify([scope, source.context.workItemId, source.context.runId, source.id, ref.sha256, exportedHash]));
      const receipt = await options.provider.put({ id: recordId, bytes: Buffer.from(bytes), mediaType: ref.mediaType, classification: ref.classification }, operation);
      if (operation?.signal?.aborted) throw new Error('Evidence mirror cancelled');
      if (options.isCurrent?.() === false) throw new Error('Evidence mirror is not authorized');
      if (!receipt || receipt.name !== recordId || typeof receipt.uri !== 'string' || !receipt.uri || receipt.uri.length > 4096) throw new Error('Invalid evidence mirror receipt');
      const remote = await options.provider.get(recordId, operation);
      if (operation?.signal?.aborted) throw new Error('Evidence mirror cancelled');
      if (options.isCurrent?.() === false) throw new Error('Evidence mirror is not authorized');
      if (!remote || remote.id !== recordId || remote.mediaType !== ref.mediaType || remote.classification !== ref.classification
        || !(remote.bytes instanceof Uint8Array) || remote.bytes.byteLength > options.maxBytes || digest(remote.bytes) !== exportedHash) {
        throw new Error('Evidence mirror readback mismatch');
      }
      return { name: recordId, uri: `evidence://${exportedHash}` };
    },
  };
  const captured = await captureEventEvidence(source, { provider: sink, evidence: options.evidence, captureEvents: true, timeoutMs: options.timeoutMs });
  if (captured === source) return { source };
  ref = Object.freeze({ ...captured.evidence!.at(-1)! });
  const alreadyReferenced = source.evidence?.some(previous => previous.uri === ref!.uri && previous.sha256 === ref!.sha256
    && previous.mediaType === ref!.mediaType && previous.classification === ref!.classification && previous.redactionStatus === ref!.redactionStatus);
  const result = alreadyReferenced ? source : captured;
  return {
    source: result,
    async mirror(sequence: number, events: EventStorePort) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, options.timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      let rejectAbort: () => void = () => undefined;
      let succeeded = false;
      let reason = 'invalid_evidence';
      try {
        await Promise.race([
          Promise.resolve().then(async () => {
            controller.signal.throwIfAborted();
            if (options.isCurrent?.() === false) throw new Error('Evidence mirror is not authorized');
            if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.uri !== `evidence://${ref.sha256}`
              || ref.mediaType !== 'application/json' || ref.classification !== 'internal' || ref.redactionStatus !== 'applied') throw new Error('Invalid captured evidence');
            const local = await options.evidence.get(ref);
            controller.signal.throwIfAborted();
            if (!(local instanceof Uint8Array) || local.byteLength > options.maxBytes || digest(local) !== ref.sha256) throw new Error('Invalid local evidence');
            const summary = JSON.parse(Buffer.from(local).toString('utf8'));
            if (summary.sourceEventId !== source.id || summary.kind !== source.data.kind || summary.occurredAt !== source.occurredAt) throw new Error('Invalid evidence identity');
            const bytes = redactUtf8(local, ref.redactionStatus).bytes;
            if (bytes.byteLength > options.maxBytes) throw new Error('Evidence mirror exceeds byte limit');
            reason = 'provider_failed';
            await sink.put({ name: `${digest(bytes)}.bin`, mediaType: ref.mediaType, bytes }, { signal: controller.signal });
          }),
          new Promise<never>((_resolve, reject) => {
            rejectAbort = () => reject(new Error('Evidence mirror cancelled'));
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
            if (controller.signal.aborted) rejectAbort();
          }),
        ]);
        controller.signal.throwIfAborted();
        succeeded = true;
      } catch {
        if (controller.signal.aborted) reason = options.signal?.aborted ? 'cancelled' : 'timed_out';
        try { options.onFailure?.(reason); } catch {}
        logger.warn({ reason }, 'Evidence mirror failed; local audit remains authoritative');
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', rejectAbort);
      }
      const idempotencyKey = `${source.id}:evidence.mirror`;
      try {
        await events.append([{
          id: randomUUID(), schemaVersion: 1, type: 'effect.completed', occurredAt: new Date().toISOString(),
          context: source.context, correlationId: source.correlationId, causationId: source.id, idempotencyKey,
          data: { kind: 'effect.completed', effectKind: 'evidence.mirror', idempotencyKey, outcome: succeeded ? 'succeeded' : 'failed',
            summary: JSON.stringify({ sourceEventId: source.id, sourceSequence: sequence, recordId, localSha256: ref?.sha256, sha256: exportedHash, reason: succeeded ? undefined : reason }) },
        }]);
      } catch {
        try { options.onFailure?.('local_receipt_failed'); } catch {}
        logger.warn({ reason: 'local_receipt_failed' }, 'Evidence mirror receipt failed; source audit remains authoritative');
      }
    },
  };
}

export function createRunObserver(root = process.env.AFK_EVENT_STORE_DIR, providers: readonly ObservabilityProviderSelection[] = [], options: RunObserverOptions = {}): RunObserver {
  const events = new JsonlEventStore({ root });
  const evidenceStore = options.evidenceStore && {
    ...options.evidenceStore,
    ...evidenceStoreSelectionSchema.omit({ provider: true }).parse({ scopes: options.evidenceStore.scopes, timeoutMs: options.evidenceStore.timeoutMs, maxBytes: options.evidenceStore.maxBytes }),
  };
  if (evidenceStore && (evidenceStore.provider.capabilities.put !== true || evidenceStore.provider.capabilities.get !== true
    || typeof evidenceStore.provider.put !== 'function' || typeof evidenceStore.provider.get !== 'function'
    || typeof evidenceStore.evidence.put !== 'function' || typeof evidenceStore.evidence.get !== 'function')) throw new Error('Invalid evidence mirror selection');
  if (!providers.length && !options.artifacts?.provider.capabilities.write && !evidenceStore) return new RunObserver({ events, onPersisted: options.onPersisted });
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
      const plans = await Promise.all(drafts.map(async draft => {
        const pinned = evidenceStore ? { ...draft, context: { ...draft.context, actor: { ...draft.context.actor } },
          data: { ...draft.data }, evidence: draft.evidence?.map(ref => ({ ...ref })) } : draft;
        const source = await captureEventEvidence(pinned, options.artifacts);
        return evidenceStore ? prepareEvidenceMirror(source, evidenceStore) : { source };
      }));
      const captured = plans.map(plan => plan.source);
      const receipt = await mirroredEvents.append(captured);
      if (auditArtifacts) {
        for (const [index, draft] of captured.entries()) await auditArtifacts(draft, receipt.firstSequence + index);
      }
      for (const [index, plan] of plans.entries()) {
        if ('mirror' in plan) await plan.mirror?.(receipt.firstSequence + index, events);
      }
      return receipt;
    },
  }, tracer, metrics, onPersisted: options.onPersisted });
}
