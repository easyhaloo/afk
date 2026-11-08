import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRef, RunEvent } from '@afk/core';
import { replay } from '@afk/core';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArtifactSink, EventStoreProvider } from '../../plugin-sdk/capabilities.js';
import { logger } from '../io/logger.js';
import { JsonlEventStore } from './jsonl-event-store.js';
import { LocalEncryptedEvidenceStore } from './local-evidence-store.js';
import { createRunObserver } from './run-observer-factory.js';

const roots: string[] = [];
const context = { traceId: 'trace', runId: 'run', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-audit-'));
  roots.push(root);
  const evidence = new LocalEncryptedEvidenceStore({ root: join(root, 'evidence'), encryptionKey: randomBytes(32) });
  const ref = await evidence.put({ bytes: Buffer.from('proof token=private-value'), mediaType: 'text/plain', classification: 'internal', redactionStatus: 'not_required' });
  const provider: ArtifactSink = { id: 'remote', capabilities: { write: true, read: false, list: false }, put: vi.fn(async artifact => ({ uri: 'https://artifacts.example/proof', name: artifact.name })) };
  const store = new JsonlEventStore({ root });
  const read = async () => {
    const events: RunEvent[] = [];
    for await (const event of store.read(context.runId)) events.push(event);
    return events;
  };
  return { root, evidence, ref, provider, store, read };
}

it('uploads actual decrypted evidence only after local persistence and audits remote hash and provenance', async () => {
  const { root, evidence, ref, provider, store, read } = await setup();
  const bytes = await evidence.get(ref);
  vi.mocked(provider.put).mockImplementation(async artifact => {
    expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 1 });
    expect(artifact.bytes).toEqual(bytes);
    expect(Buffer.from(artifact.bytes).toString()).toBe('proof token=[redacted]');
    return { uri: 'https://artifacts.example/proof', name: 'remote-proof' };
  });
  const receipt = await createRunObserver(root, [], { artifacts: { provider, evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  const events = await read();
  expect(receipt).toMatchObject({ lastSequence: 1, lastHash: events[0].integrity.hash });
  expect(events).toHaveLength(2);
  expect(events[0].evidence).toEqual([ref]);
  expect(events[1]).toMatchObject({ type: 'effect.completed', causationId: events[0].id, context, data: { kind: 'effect.completed', effectKind: 'artifact.upload', outcome: 'succeeded' }, evidence: [{ ...ref, uri: 'https://artifacts.example/proof' }] });
  expect(JSON.parse((events[1].data as { summary: string }).summary)).toMatchObject({ providerId: 'remote', sourceEventId: events[0].id, sourceSequence: 1, localUri: ref.uri, localSha256: ref.sha256, sha256: ref.sha256, artifact: { uri: 'https://artifacts.example/proof', name: 'remote-proof' } });
  expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
  expect(provider.put).toHaveBeenCalledTimes(1);
});

it.each(['rejected', 'integrity', 'restricted', 'missing'] as const)('records %s upload failure without losing local evidence or leaking errors', async failure => {
  const { root, evidence, ref, provider, store, read } = await setup();
  const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const local = failure === 'restricted' ? { ...ref, redactionStatus: 'restricted' as const } : ref;
  const reader = failure === 'integrity' ? { get: async () => Buffer.from('tampered') } : failure === 'missing' ? { get: async () => { throw new Error('password=private-error'); } } : evidence;
  vi.mocked(provider.put).mockRejectedValue(new Error('token=private-error'));
  await expect(createRunObserver(root, [], { artifacts: { provider, evidence: reader } }).record(context, { kind: 'qa.passed' }, { evidence: [local] })).resolves.toMatchObject({ lastSequence: 1 });
  const events = await read();
  expect(events[0].evidence).toEqual([local]);
  expect(events[1].data).toMatchObject({ kind: 'effect.completed', effectKind: 'artifact.upload', outcome: 'failed' });
  expect(await evidence.get(ref)).toEqual(Buffer.from('proof token=[redacted]'));
  expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
  expect(JSON.stringify([events, warning.mock.calls])).not.toContain('private-error');
  if (failure !== 'rejected') expect(provider.put).not.toHaveBeenCalled();
});

it('never exports restricted evidence after local redaction changes its bytes', async () => {
  const { root, evidence, provider, read } = await setup();
  const ref = await evidence.put({ bytes: Buffer.from('password=review-private-password'), mediaType: 'text/plain', classification: 'sensitive', redactionStatus: 'restricted' });
  expect(Buffer.from(await evidence.get(ref)).toString()).toBe('password=[redacted]');
  expect(ref.redactionStatus).toBe('restricted');
  await createRunObserver(root, [], { artifacts: { provider, evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  expect(provider.put).not.toHaveBeenCalled();
  const events = await read();
  expect(events[0].evidence).toEqual([ref]);
  expect(events[1].data).toMatchObject({ effectKind: 'artifact.upload', outcome: 'failed' });
  expect(JSON.parse((events[1].data as { summary: string }).summary)).toMatchObject({ reason: 'restricted' });
});

it('leaves uploads disabled unless explicitly selected and permitted', async () => {
  const { root, ref, provider, read } = await setup();
  const evidence = { get: vi.fn(async () => Buffer.from('unused')) };
  await createRunObserver(root).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  const disabled = { ...provider, capabilities: { ...provider.capabilities, write: false } };
  await createRunObserver(root, [], { artifacts: { provider: disabled, evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  expect(evidence.get).not.toHaveBeenCalled();
  expect(provider.put).not.toHaveBeenCalled();
  expect(await read()).toHaveLength(2);
});

it('bounds a hung upload, aborts its signal, and ignores late completion', async () => {
  const { root, ref, evidence, provider, store, read } = await setup();
  let finish!: (artifact: { uri: string; name: string }) => void;
  vi.mocked(provider.put).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers();
  const recording = createRunObserver(root, [], { artifacts: { provider, evidence, timeoutMs: 20 } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  await vi.waitFor(() => expect(provider.put).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(20);
  await expect(recording).resolves.toMatchObject({ lastSequence: 1 });
  expect(vi.mocked(provider.put).mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(JSON.parse(((await read())[1].data as { summary: string }).summary)).toMatchObject({ reason: 'timed_out' });
  finish({ uri: 'https://artifacts.example/late', name: 'late' });
  await Promise.resolve();
  expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
});

it('cancels a pending local read before it can upload', async () => {
  const { root, ref, provider, read } = await setup();
  const controller = new AbortController();
  const evidence = { get: vi.fn(() => new Promise<Uint8Array>(() => undefined)) };
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const recording = createRunObserver(root, [], { artifacts: { provider, evidence, signal: controller.signal } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  await vi.waitFor(() => expect(evidence.get).toHaveBeenCalled());
  controller.abort(new Error('token=private-abort'));
  await expect(recording).resolves.toMatchObject({ lastSequence: 1 });
  expect(provider.put).not.toHaveBeenCalled();
  expect(JSON.parse(((await read())[1].data as { summary: string }).summary)).toMatchObject({ reason: 'aborted' });
});

it('redacts JSON secrets before upload and sanitizes remote reference credentials', async () => {
  const { root, provider, read } = await setup();
  const bytes = Buffer.from('{"password":"private-json","result":"passed"}');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ref: EvidenceRef = { uri: `evidence://${sha256}`, sha256, mediaType: 'application/json', classification: 'sensitive', redactionStatus: 'not_required' };
  vi.mocked(provider.put).mockImplementation(async artifact => ({ uri: 'https://user:private-auth@artifacts.example/proof?token=private-query#private-fragment', name: 'password=private-name' }));
  await createRunObserver(root, [], { artifacts: { provider, evidence: { get: async () => bytes } } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  const uploaded = vi.mocked(provider.put).mock.calls[0][0];
  expect(Buffer.from(uploaded.bytes).toString()).toBe('{"password":"[redacted]","result":"passed"}');
  const remoteHash = createHash('sha256').update(uploaded.bytes).digest('hex');
  const events = await read();
  expect(events[0].evidence).toEqual([ref]);
  expect(events[1].evidence).toEqual([{ ...ref, sha256: remoteHash, uri: 'https://artifacts.example/proof', redactionStatus: 'applied' }]);
  expect(JSON.stringify(events)).not.toContain('private-');
});

it('does not recursively upload artifact audit evidence or fabricate evidence for other events', async () => {
  const { root, ref, evidence, provider, read } = await setup();
  const observer = createRunObserver(root, [], { artifacts: { provider, evidence } });
  await observer.record(context, { kind: 'run.started' });
  await observer.record(context, { kind: 'effect.completed', effectKind: 'artifact.upload', idempotencyKey: 'upload', outcome: 'succeeded' }, { evidence: [ref] });
  expect(provider.put).not.toHaveBeenCalled();
  expect(await read()).toHaveLength(2);
});

it('preserves arbitrary binary bytes and isolates concurrent run provenance', async () => {
  const { root, provider, store } = await setup();
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ref: EvidenceRef = { uri: `evidence://${sha256}`, sha256, mediaType: 'application/octet-stream', classification: 'public', redactionStatus: 'not_required' };
  const observer = createRunObserver(root, [], { artifacts: { provider, evidence: { get: async () => bytes } } });
  await Promise.all(['one', 'two'].map(runId => observer.record({ ...context, runId }, { kind: 'qa.passed' }, { evidence: [ref] })));
  expect(provider.put).toHaveBeenCalledTimes(2);
  expect(vi.mocked(provider.put).mock.calls.every(([artifact]) => Buffer.from(artifact.bytes).equals(bytes))).toBe(true);
  for (const runId of ['one', 'two']) {
    const events: RunEvent[] = [];
    for await (const event of store.read(runId)) events.push(event);
    expect(events[1]).toMatchObject({ context: { runId }, causationId: events[0].id });
    expect(await store.verify(runId)).toMatchObject({ valid: true, lastSequence: 2 });
  }
});

it('honors cancellation before starting a read and persists its failure outcome', async () => {
  const { root, ref, provider, read } = await setup();
  const evidence = { get: vi.fn() };
  const controller = new AbortController();
  controller.abort();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  await createRunObserver(root, [], { artifacts: { provider, evidence, signal: controller.signal } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  expect(evidence.get).not.toHaveBeenCalled();
  expect(provider.put).not.toHaveBeenCalled();
  expect(JSON.parse(((await read())[1].data as { summary: string }).summary)).toMatchObject({ reason: 'aborted' });
});

it('rejects unsafe evidence references before invoking the local reader', async () => {
  const { root, provider, read } = await setup();
  const evidence = { get: vi.fn() };
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const ref: EvidenceRef = { uri: 'evidence://../../private-token', sha256: '../../private-token', mediaType: 'text/plain', classification: 'internal', redactionStatus: 'not_required' };
  await createRunObserver(root, [], { artifacts: { provider, evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  expect(evidence.get).not.toHaveBeenCalled();
  expect(provider.put).not.toHaveBeenCalled();
  const summary = JSON.parse(((await read())[1].data as { summary: string }).summary);
  expect(summary).toMatchObject({ reason: 'invalid_evidence' });
  expect(summary.localUri).toBeUndefined();
});

it('keeps local audit persistence failures fatal and prevents external writes', async () => {
  const { root, ref, evidence, provider } = await setup();
  const { writeFile } = await import('node:fs/promises');
  const path = join(root, 'not-a-directory');
  await writeFile(path, 'file');
  await expect(createRunObserver(path, [], { artifacts: { provider, evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] })).rejects.toThrow();
  expect(provider.put).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, Infinity, 2_147_483_648])('rejects invalid upload timeout %s before recording', async timeoutMs => {
  const { root, provider, evidence } = await setup();
  expect(() => createRunObserver(root, [], { artifacts: { provider, evidence, timeoutMs } })).toThrow(/timeout/);
});

it('preserves lifecycle replay when verification evidence is uploaded before completion', async () => {
  const { root, provider, evidence, ref, read } = await setup();
  const observer = createRunObserver(root, [], { artifacts: { provider, evidence } });
  await observer.record(context, { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId, profileId: context.profileId, attempt: 1, status: 'pending' } });
  await observer.record(context, { kind: 'run.started' });
  await observer.record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  await observer.record(context, { kind: 'run.finished', outcome: 'succeeded' });
  expect(replay(await read())).toMatchObject({ terminal: true, sequence: 5, run: { status: 'succeeded' } });
});

it('mirrors upload outcomes with their local sequences without uploading audit records', async () => {
  const { root, provider, evidence, ref, read } = await setup();
  const append = vi.fn<Parameters<EventStoreProvider['append']>, ReturnType<EventStoreProvider['append']>>(async () => undefined);
  const observer = createRunObserver(root, [{ provider: { id: 'mirror', capabilities: { append: true }, append }, signals: ['events'] }], { artifacts: { provider, evidence } });
  await observer.record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  const events = await read();
  expect(append.mock.calls.map(([batch]) => batch[0])).toMatchObject([
    { sequence: 1, type: 'qa.passed', payload: { id: events[0].id, evidence: [ref] } },
    { sequence: 2, type: 'effect.completed', payload: { causationId: events[0].id, data: { effectKind: 'artifact.upload' }, evidence: events[1].evidence } },
  ]);
  expect(provider.put).toHaveBeenCalledTimes(1);
});

it.each(['qa.failed', 'qa.passed', 'change.published', 'run.finished', 'failure.classified'] as const)('captures bounded redacted JSON evidence from %s without supplied references', async kind => {
  const { root, evidence, provider, read } = await setup();
  const data = kind === 'qa.failed' ? { kind, summary: 'password=private-value' }
    : kind === 'change.published' ? { kind, changeId: '1', url: 'https://example.test/change?token=private-value' }
    : kind === 'run.finished' ? { kind, outcome: 'failed' as const, reason: 'token=private-value' }
    : kind === 'failure.classified' ? { kind, failureClass: 'agent', summary: 'password=private-value' }
    : { kind };
  await createRunObserver(root, [], { artifacts: { provider, evidence, captureEvents: true } }).record(context, data);
  const events = await read();
  expect(events[0].evidence).toHaveLength(1);
  const ref = events[0].evidence![0];
  const bytes = await evidence.get(ref);
  expect(bytes.byteLength).toBeLessThanOrEqual(16_384);
  expect(JSON.parse(Buffer.from(bytes).toString())).toMatchObject({ kind });
  expect(Buffer.from(bytes).toString()).not.toContain('private-value');
  expect(vi.mocked(provider.put).mock.calls[0][0].bytes).toEqual(bytes);
  expect(provider.put).toHaveBeenCalledTimes(1);
  expect(events[1].data).toMatchObject({ effectKind: 'artifact.upload', outcome: 'succeeded' });
});

it.each(['change.published', 'qa.failed'] as const)('removes URL credentials before capturing and uploading %s evidence', async kind => {
  const { root, evidence, provider, read } = await setup();
  const url = 'https://user:review-private-password@example.test/pr/1';
  const data = kind === 'change.published' ? { kind, changeId: '1', url }
    : { kind, summary: `Publishing ${url} failed; retry later` };
  await createRunObserver(root, [], { artifacts: { provider, evidence, captureEvents: true } }).record(context, data);
  const events = await read();
  const ref = events[0].evidence![0];
  const bytes = await evidence.get(ref);
  const summary = Buffer.from(bytes).toString();
  expect(JSON.parse(summary)).toMatchObject(kind === 'change.published'
    ? { url: 'https://example.test/pr/1' }
    : { summary: 'Publishing https://example.test/pr/1 failed; retry later' });
  expect(summary).not.toContain('review-private-password');
  expect(summary).not.toContain('user:');
  expect(ref.redactionStatus).toBe('applied');
  expect(provider.put).toHaveBeenCalledTimes(1);
  expect(vi.mocked(provider.put).mock.calls[0][0].bytes).toEqual(bytes);
});

it('bounds capture size while retaining valid JSON, and excludes unrelated events', async () => {
  const { root, evidence, provider, read } = await setup();
  const observer = createRunObserver(root, [], { artifacts: { provider, evidence, captureEvents: true } });
  await observer.record(context, { kind: 'run.started' });
  await observer.record(context, { kind: 'qa.failed', summary: '🔒'.repeat(30_000), evidence: Array.from({ length: 1000 }, () => ({ kind: 'output', label: 'diagnostic', detail: 'token=private-value' })) });
  const events = await read();
  expect(events[0].evidence).toBeUndefined();
  const bytes = await evidence.get(events[1].evidence![0]);
  expect(bytes.byteLength).toBeLessThanOrEqual(16_384);
  expect(JSON.parse(Buffer.from(bytes).toString())).toMatchObject({ kind: 'qa.failed', truncated: true });
  expect(provider.put).toHaveBeenCalledTimes(1);
});

it.each(['javascript://example.test/proof', 'data://example.test/proof', 'ftp://example.test/proof'])('rejects unsafe artifact URI %s', async uri => {
  const { root, ref, evidence, provider, read } = await setup();
  vi.mocked(provider.put).mockResolvedValue({ uri, name: 'proof' });
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  await createRunObserver(root, [], { artifacts: { provider, evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  expect((await read())[1].data).toMatchObject({ outcome: 'failed' });
});

it.each(['http://example.test/proof', 'file:///private/proof', 's3://bucket/proof', 'gs://bucket/proof'])('accepts artifact URI %s', async uri => {
  const { root, ref, evidence, provider, read } = await setup();
  vi.mocked(provider.put).mockResolvedValue({ uri, name: 'proof' });
  await createRunObserver(root, [], { artifacts: { provider, evidence } }).record(context, { kind: 'qa.passed' }, { evidence: [ref] });
  expect((await read())[1]).toMatchObject({ data: { outcome: 'succeeded' }, evidence: [{ uri }] });
});

it('rejects capture configuration without a local writer before recording', async () => {
  const { root, provider } = await setup();
  expect(() => createRunObserver(root, [], { artifacts: { provider, evidence: { get: vi.fn() }, captureEvents: true } })).toThrow('Event evidence capture requires a writable local evidence store');
});

it('preserves captured local evidence when the remote upload fails', async () => {
  const { root, evidence, provider, read, store } = await setup();
  vi.mocked(provider.put).mockRejectedValue(new Error('password=private-provider-error'));
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  await createRunObserver(root, [], { artifacts: { provider, evidence, captureEvents: true } }).record(context, { kind: 'qa.passed' });
  const events = await read();
  expect(JSON.parse(Buffer.from(await evidence.get(events[0].evidence![0])).toString())).toMatchObject({ kind: 'qa.passed' });
  expect(events[1].data).toMatchObject({ outcome: 'failed' });
  expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
});

it('persists the original audit when local capture fails without logging secret errors', async () => {
  const { root, provider, evidence, read } = await setup();
  const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(evidence, 'put').mockRejectedValue(new Error('token=private-value'));
  await expect(createRunObserver(root, [], { artifacts: { provider, evidence, captureEvents: true } }).record(context, { kind: 'qa.passed' })).resolves.toMatchObject({ lastSequence: 1 });
  expect(await read()).toMatchObject([{ type: 'qa.passed' }]);
  expect(provider.put).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith({ reason: 'evidence_capture_failed' }, expect.any(String));
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private-value');
});

it('does not capture event evidence unless capture is explicitly enabled', async () => {
  const { root, evidence, provider, read } = await setup();
  const put = vi.spyOn(evidence, 'put');
  await createRunObserver(root, [], { artifacts: { provider, evidence } }).record(context, { kind: 'qa.passed' });
  await createRunObserver(root, [], { artifacts: { provider: { ...provider, capabilities: { ...provider.capabilities, write: false } }, evidence, captureEvents: true } }).record(context, { kind: 'qa.passed' });
  expect(put).not.toHaveBeenCalled();
  expect(provider.put).not.toHaveBeenCalled();
  expect(await read()).toHaveLength(2);
});

it.each(['timeout', 'abort'] as const)('persists the source audit after capture %s and ignores a late local write', async mode => {
  const { root, evidence, provider, ref, read } = await setup();
  let finish!: (value: EvidenceRef) => void;
  const put = vi.spyOn(evidence, 'put').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers();
  const recording = createRunObserver(root, [], { artifacts: { provider, evidence, captureEvents: true, timeoutMs: 50, signal: controller.signal } }).record(context, { kind: 'qa.passed' });
  await vi.waitFor(() => expect(put).toHaveBeenCalled());
  if (mode === 'abort') controller.abort();
  else await vi.advanceTimersByTimeAsync(50);
  await expect(recording).resolves.toMatchObject({ lastSequence: 1 });
  finish(ref);
  await Promise.resolve();
  expect(await read()).toMatchObject([{ type: 'qa.passed' }]);
  expect(provider.put).not.toHaveBeenCalled();
});
