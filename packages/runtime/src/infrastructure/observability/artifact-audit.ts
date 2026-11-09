import { createHash, randomUUID } from 'node:crypto';
import type { EvidenceRef, EvidenceStorePort, EventStorePort, RunEventDraft } from '@afk/core';
import type { ArtifactSink } from '../../plugin-sdk/capabilities.js';
import { logger } from '../io/logger.js';
import { redactUtf8 } from './local-evidence-store.js';

export interface ArtifactAuditOptions {
  readonly provider: ArtifactSink;
  readonly evidence: { get(ref: EvidenceRef): Promise<Uint8Array>; put?: EvidenceStorePort['put'] };
  readonly captureEvents?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function createArtifactAudit(events: Pick<EventStorePort, 'append'>, options?: ArtifactAuditOptions) {
  if (!options?.provider.capabilities.write) return undefined;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Artifact upload timeout must be a positive timer duration');
  const { provider, evidence, signal } = options;
  if (options.captureEvents && !evidence.put) throw new Error('Event evidence capture requires a writable local evidence store');
  const providerId = Buffer.from(redactUtf8(Buffer.from(provider.id)).bytes).toString('utf8');

  return async (source: RunEventDraft, sourceSequence: number): Promise<void> => {
    if ((source.data.kind === 'effect.started' || source.data.kind === 'effect.completed') && source.data.effectKind === 'artifact.upload') return;
    for (const [index, ref] of (source.evidence ?? []).entries()) {
      const controller = new AbortController();
      let reason = 'upload_failed';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { reason = 'aborted'; controller.abort(); };
      let rejectAbort: () => void = () => undefined;
      let remote: EvidenceRef | undefined;
      let artifact: { uri: string; name: string } | undefined;
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(new Error('Artifact upload aborted'));
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        timer = setTimeout(() => { reason = 'timed_out'; controller.abort(); }, timeoutMs);
        remote = await Promise.race([
          Promise.resolve().then(async () => {
            controller.signal.throwIfAborted();
            reason = 'invalid_evidence';
            if (!/^[a-f0-9]{64}$/.test(ref.sha256) || ref.uri !== `evidence://${ref.sha256}`) throw new Error('Invalid local evidence reference');
            reason = 'restricted';
            if (ref.redactionStatus === 'restricted') throw new Error('Restricted evidence cannot be exported');
            reason = 'read_failed';
            const local = await evidence.get(ref);
            controller.signal.throwIfAborted();
            reason = 'integrity_mismatch';
            if (createHash('sha256').update(local).digest('hex') !== ref.sha256) throw new Error('Local evidence integrity mismatch');
            let bytes = local;
            let redactionStatus: EvidenceRef['redactionStatus'] = ref.redactionStatus;
            if (/^(text\/|application\/(?:[^;]+\+)?(?:json|xml|javascript|typescript|x-yaml|yaml)(?:;|$))/i.test(ref.mediaType)) {
              const normalized = redactUtf8(local, redactionStatus);
              bytes = normalized.bytes;
              redactionStatus = normalized.redactionStatus;
            }
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const name = `${sha256}.bin`;
            reason = 'upload_failed';
            const result = await provider.put({ name, mediaType: ref.mediaType, bytes }, { signal: controller.signal });
            controller.signal.throwIfAborted();
            reason = 'invalid_artifact';
            if (typeof result.name !== 'string' || !result.name.trim()) throw new Error('Invalid remote artifact name');
            const uri = new URL(result.uri);
            if (!['http:', 'https:', 'file:', 's3:', 'gs:'].includes(uri.protocol) || (!uri.hostname && uri.protocol !== 'file:')) throw new Error('Invalid remote artifact URI');
            uri.username = '';
            uri.password = '';
            uri.search = '';
            uri.hash = '';
            artifact = {
              uri: Buffer.from(redactUtf8(Buffer.from(uri.href)).bytes).toString('utf8'),
              name: Buffer.from(redactUtf8(Buffer.from(result.name)).bytes).toString('utf8'),
            };
            return { ...ref, uri: artifact.uri, sha256, redactionStatus };
          }),
          cancelled,
        ]);
      } catch {
        logger.warn({ provider_id: providerId, reason }, 'Artifact upload failed; local audit remains authoritative');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', rejectAbort);
      }
      const idempotencyKey = `${source.id}:artifact.upload:${index}`;
      const validLocal = /^[a-f0-9]{64}$/.test(ref.sha256) && ref.uri === `evidence://${ref.sha256}`;
      await events.append([{
        id: randomUUID(), schemaVersion: 1, type: 'effect.completed', occurredAt: new Date().toISOString(),
        context: source.context, correlationId: source.correlationId, causationId: source.id, idempotencyKey,
        data: {
          kind: 'effect.completed', effectKind: 'artifact.upload', idempotencyKey, outcome: remote ? 'succeeded' : 'failed',
          summary: JSON.stringify({ providerId, sourceEventId: source.id, sourceSequence, localUri: validLocal ? ref.uri : undefined,
            localSha256: validLocal ? ref.sha256 : undefined, sha256: remote?.sha256, artifact, reason: remote ? undefined : reason }),
        },
        evidence: remote ? [remote] : undefined,
      }]);
    }
  };
}

export async function captureEventEvidence(source: RunEventDraft, options?: ArtifactAuditOptions): Promise<RunEventDraft> {
  if (!options?.captureEvents || !options.provider.capabilities.write || !['qa.failed', 'qa.passed', 'change.published', 'run.finished', 'failure.classified'].includes(source.data.kind)) return source;
  const summary: Record<string, string | number | boolean> = { kind: source.data.kind, sourceEventId: source.id, occurredAt: source.occurredAt };
  let truncated = false;
  for (const [name, value] of Object.entries(source.data)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') { truncated = true; continue; }
    const normalized = typeof value === 'string' ? Buffer.from(redactUtf8(Buffer.from(value)).bytes).toString('utf8') : value;
    const bounded = typeof normalized === 'string' ? normalized.slice(0, 1_024) : normalized;
    const fits = Buffer.byteLength(JSON.stringify({ ...summary, [name]: bounded, truncated: true })) <= 16_384;
    if (bounded !== normalized || !fits) truncated = true;
    if (fits) summary[name] = bounded;
  }
  if (truncated) summary.truncated = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Event evidence capture aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      timer = setTimeout(() => reject(new Error('Event evidence capture timed out')), options.timeoutMs ?? 5_000);
    });
    const ref = await Promise.race([
      Promise.resolve().then(() => {
        options.signal?.throwIfAborted();
        return options.evidence.put!({ bytes: Buffer.from(JSON.stringify(summary)), mediaType: 'application/json', classification: 'internal', redactionStatus: 'applied' });
      }), cancelled,
    ]);
    return { ...source, evidence: [...source.evidence ?? [], ref] };
  } catch {
    logger.warn({ reason: 'evidence_capture_failed' }, 'Event evidence capture failed; local audit remains authoritative');
    return source;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
