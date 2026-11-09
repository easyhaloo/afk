import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, chmodSync, readFileSync, linkSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, requireNodeSqlite, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';
import { createRequire } from 'node:module';
import { CandidateStore } from './candidate-store.js';
import { buildEvidencePack } from './evidence.js';
import { request, evidence, output } from './ledger-data.fixture.spec.js';

let root: string;
let file: string;
let fixtureRoot: string;
let fixture: string;
const stores: CandidateStore[] = [];
const children: ChildProcess[] = [];
const childErrors = new WeakMap<ChildProcess, string>();
const input = { request, evidence: [evidence] };
const scan = { scope: request.scope, runId: 'r1', analyzerVersion: '1', expectedCursor: null,
  cursor: { sequence: 1, head: 'c'.repeat(64) }, requests: [input] };
const sqlite = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));

function open(limits?: ConstructorParameters<typeof CandidateStore>[0]['limits']) {
  const store = new CandidateStore({ file, limits });
  stores.push(store);
  return store;
}

function response(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('error', error);
      child.off('exit', exit);
    };
    const message = (value: unknown) => { clean(); resolve(value); };
    const error = (value: Error) => { clean(); reject(value); };
    const exit = (code: number | null, signal: string | null) => error(new Error(`Child exited before IPC response (${code ?? signal}): ${childErrors.get(child) ?? ''}`));
    const timer = setTimeout(() => error(new Error('child response timeout')), 10000);
    child.once('message', message);
    child.once('error', error);
    child.once('exit', exit);
  });
}

async function startChild(execArgv?: string[]) {
  const child = fork(fixture, [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], ...(execArgv ? { execArgv } : {}) });
  child.stderr?.on('data', chunk => childErrors.set(child, `${childErrors.get(child) ?? ''}${chunk}`.slice(-4000)));
  children.push(child);
  expect(await response(child)).toBe('ready');
  return child;
}

function send(child: ChildProcess, message: unknown) {
  const result = response(child);
  child.send(message as never);
  return result;
}

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), 'learning-process-'));
  fixture = join(fixtureRoot, 'producer.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./ledger-process.fixture.spec.ts', import.meta.url))],
    outfile: fixture, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-ledger-')); file = join(root, 'private', 'learning.sqlite'); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exit;
  }
  for (const store of stores.splice(0)) store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('private learning ledger', () => {
  it('atomically starts a request-bound analysis attempt and preserves its original owner on replay', () => {
    const store = open();
    const entry = store.submitRequest(input);
    const start = { requestKey: entry.key, callId: 'analysis:one', day: '2026-11-09', limit: 1,
      startedAt: '2026-11-09T10:00:00.000Z' };
    const attempt = store.startAnalysisAttempt(start);
    expect(attempt).toEqual({ requestKey: entry.key, callId: start.callId, day: start.day,
      startedAt: start.startedAt, ownerPid: process.pid, host: hostname(), status: 'started' });
    expect(store.startAnalysisAttempt(start)).toEqual(attempt);
    expect(store.reserveModelCall({ day: start.day, callId: start.callId, limit: 1 }).ordinal).toBe(1);
    expect(store.getModelCallCount(start.day)).toBe(1);
    expect(store.listAnalysisAttempts(entry.key)).toEqual([attempt]);
    expect(store.listAnalysisAttempts('f'.repeat(64))).toEqual([]);
    for (const change of [{ startedAt: '2026-11-09T10:00:01.000Z' }, { day: '2026-11-10' }]) {
      expect(() => store.startAnalysisAttempt({ ...start, ...change })).toThrow(/content|conflict/i);
    }
    const other = store.submitRequest({ ...input, request: { ...request, sourceId: 'other-run' } });
    expect(() => store.startAnalysisAttempt({ ...start, requestKey: other.key })).toThrow(/content|conflict/i);
    expect(store.getModelCallCount('2026-11-10')).toBe(0);
    expect(store.listAnalysisAttempts()).toEqual([attempt]);
    store.close();
    expect(open().listAnalysisAttempts()).toEqual([attempt]);
  });

  it('rolls back both a new budget reservation and attempt when capacity or request validation fails', () => {
    const store = open({ records: 2 });
    const entry = store.submitRequest(input);
    const start = { requestKey: entry.key, callId: 'analysis:full', day: '2026-11-09', limit: 1,
      startedAt: '2026-11-09T10:00:00.000Z' };
    expect(() => store.startAnalysisAttempt(start)).toThrow(/capacity/i);
    expect(store.listAnalysisAttempts()).toEqual([]);
    expect(store.getModelCallCount(start.day)).toBe(0);
    expect(() => store.startAnalysisAttempt({ ...start, requestKey: 'f'.repeat(64) })).toThrow(/request.*not found/i);
    expect(() => store.startAnalysisAttempt({ ...start, startedAt: 'yesterday' })).toThrow();
    expect(() => store.startAnalysisAttempt({ ...start, ownerPid: 42 } as never)).toThrow();
    expect(() => store.startAnalysisAttempt({ ...start, limit: 0 })).toThrow(/budget/i);
    expect(store.getModelCallCount(start.day)).toBe(0);
    store.reserveModelCall({ day: start.day, callId: 'already-spent', limit: 1 });
    expect(() => store.startAnalysisAttempt({ ...start, callId: 'already-spent' })).toThrow(/capacity/i);
    expect(store.getModelCallCount(start.day)).toBe(1);
    expect(store.listAnalysisAttempts()).toEqual([]);
  });

  it.each(['source_invalidated', 'source_unstable'])('atomically refuses a %s source before reserving a paid attempt', blockedReason => {
    const store = open();
    const entry = store.submitRequest(input);
    store.setRequestBlocked(entry.key, blockedReason);
    expect(() => store.startAnalysisAttempt({ requestKey: entry.key, day: '2026-11-10', callId: 'blocked-call', limit: 20,
      startedAt: '2026-11-10T00:00:00.000Z' })).toThrow(/blocked/i);
    expect(store.getModelCallCount('2026-11-10')).toBe(0);
    expect(store.listAnalysisAttempts(entry.key)).toEqual([]);
    store.setRequestBlocked(entry.key, null, 'budget_exhausted');
    expect(store.getRequest(entry.key)?.blockedReason).toBe(blockedReason);
    store.setRequestBlocked(entry.key, 'analysis_failed', null);
    expect(store.getRequest(entry.key)?.blockedReason).toBe(blockedReason);
    store.setRequestBlocked(entry.key, null, blockedReason);
    expect(store.getRequest(entry.key)?.blockedReason).toBeUndefined();
  });

  it('records analysis identity once, rejects replacing either ID and keeps it across restart', () => {
    const store = open();
    const entry = store.submitRequest(input);
    store.startAnalysisAttempt({ requestKey: entry.key, callId: 'identity', day: '2026-11-09', limit: 1,
      startedAt: '2026-11-09T10:00:00.000Z' });
    const identity = { analysisRunId: 'analysis-run:1', sessionId: 'session:1' };
    const recorded = store.recordAnalysisIdentity('identity', identity);
    expect(recorded).toMatchObject(identity);
    expect(store.recordAnalysisIdentity('identity', identity)).toEqual(recorded);
    expect(() => store.recordAnalysisIdentity('identity', { ...identity, analysisRunId: 'analysis-run:2' })).toThrow(/identity|content|replace/i);
    expect(() => store.recordAnalysisIdentity('identity', { ...identity, sessionId: 'session:2' })).toThrow(/identity|content|replace/i);
    expect(() => store.recordAnalysisIdentity('missing', identity)).toThrow(/attempt.*not found/i);
    expect(() => store.finishAnalysisAttempt('missing', { status: 'failed', finishedAt: '2026-11-09T10:00:01.000Z' })).toThrow(/attempt.*not found/i);
    store.close();
    expect(open().listAnalysisAttempts(entry.key)).toEqual([recorded]);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('persists an idempotent %s result and rejects conflicting terminal data', status => {
    const store = open();
    const entry = store.submitRequest(input);
    const start = { requestKey: entry.key, callId: 'finished', day: '2026-11-09', limit: 1,
      startedAt: '2026-11-09T10:00:00.000Z' };
    store.startAnalysisAttempt(start);
    store.recordAnalysisIdentity(start.callId, { analysisRunId: 'analysis:run', sessionId: 'analysis:session' });
    const result = { status, finishedAt: '2026-11-09T10:00:01.000Z',
      ...(status === 'succeeded' ? { usage: { inputTokens: 0, outputTokens: 2 } } : { errorCode: 'ANALYSIS_ABORTED' }) };
    const finished = store.finishAnalysisAttempt(start.callId, result);
    expect(finished).toMatchObject(result);
    expect(finished).toMatchObject({ analysisRunId: 'analysis:run', sessionId: 'analysis:session' });
    if (status !== 'succeeded') expect(finished).not.toHaveProperty('usage');
    else expect(finished.usage).not.toHaveProperty('totalTokens');
    expect(store.finishAnalysisAttempt(start.callId, result)).toEqual(finished);
    expect(store.startAnalysisAttempt(start)).toEqual(finished);
    for (const change of [{ finishedAt: '2026-11-09T10:00:02.000Z' }, { status: 'failed' as const, errorCode: 'DIFFERENT_ERROR' },
      { usage: { inputTokens: 1 } }]) {
      expect(() => store.finishAnalysisAttempt(start.callId, { ...result, ...change })).toThrow(/terminal|content|conflict/i);
    }
    expect(store.getModelCallCount(start.day)).toBe(1);
    store.close();
    expect(open().listAnalysisAttempts()).toEqual([finished]);
  });

  it('rejects raw errors, invalid timestamps and invalid usage without turning unknown usage into zeros', () => {
    const store = open();
    const entry = store.submitRequest(input);
    store.startAnalysisAttempt({ requestKey: entry.key, callId: 'unknown', day: '2026-11-09', limit: 1,
      startedAt: '2026-11-09T10:00:00.000Z' });
    const result = { status: 'failed' as const, finishedAt: '2026-11-09T10:00:01.000Z' };
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2']) {
      expect(() => store.finishAnalysisAttempt('unknown', { ...result, usage: { inputTokens: value } } as never)).toThrow();
    }
    for (const usage of [{}, { inputTokens: undefined }, { cost: 0 }]) {
      expect(() => store.finishAnalysisAttempt('unknown', { ...result, usage } as never)).toThrow();
    }
    for (const change of [{ errorCode: 'provider failed: secret response' }, { errorCode: 'A'.repeat(65) },
      { error: 'raw provider response' }, { finishedAt: 'not-ISO' }, { finishedAt: '2026-11-09T09:59:59.000Z' }]) {
      expect(() => store.finishAnalysisAttempt('unknown', { ...result, ...change })).toThrow();
    }
    expect(store.listAnalysisAttempts()[0]?.status).toBe('started');
    const finished = store.finishAnalysisAttempt('unknown', { ...result, usage: undefined, errorCode: undefined });
    expect(finished).not.toHaveProperty('usage');
    expect(finished).not.toHaveProperty('errorCode');
    store.close();
    expect(open().listAnalysisAttempts()[0]).toEqual(finished);
  });

  it('retains a started attempt and its original owner after a real producer is killed', async () => {
    const attemptFixture = join(fixtureRoot, 'analysis-owner.mjs');
    await build({ stdin: { contents: `
      import { CandidateStore } from './candidate-store.js';
      const store = new CandidateStore({ file: process.argv[2] });
      const entry = store.submitRequest(JSON.parse(process.argv[3]));
      process.send(store.startAnalysisAttempt({ requestKey: entry.key, callId: 'crashed-analysis',
        day: '2026-11-09', limit: 1, startedAt: '2026-11-09T10:00:00.000Z' }));
      process.on('message', () => {});
    `, resolveDir: fileURLToPath(new URL('.', import.meta.url)) }, outfile: attemptFixture,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const child = fork(attemptFixture, [file, JSON.stringify(input)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    const attempt = await response(child);
    expect(attempt).toMatchObject({ ownerPid: child.pid, host: hostname(), status: 'started' });
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exit;
    const restarted = open();
    expect(restarted.listAnalysisAttempts()).toEqual([attempt]);
    expect(restarted.listAnalysisAttempts()[0]).not.toHaveProperty('finishedAt');
    expect(restarted.listAnalysisAttempts()[0]).not.toHaveProperty('usage');
    expect(restarted.getModelCallCount('2026-11-09')).toBe(1);
  });

  it('reserves UTC daily model calls idempotently and retains spent reservations across restart', () => {
    const store = open();
    const reservation = { day: '2026-11-09', callId: 'request:1/attempt:1', limit: 1 };
    expect(store.reserveModelCall(reservation)).toEqual({ day: reservation.day, callId: reservation.callId, ordinal: 1 });
    expect(store.reserveModelCall(reservation).ordinal).toBe(1);
    expect(store.getModelCallCount(reservation.day)).toBe(1);
    expect(() => store.reserveModelCall({ ...reservation, callId: 'request:1/attempt:2' })).toThrow(/budget/i);
    expect(() => store.reserveModelCall({ ...reservation, day: '2026-11-10', limit: 0 })).toThrow(/budget/i);
    expect(() => store.reserveModelCall({ ...reservation, day: '2026-02-30' })).toThrow();
    expect(() => store.getModelCallCount('2026-11-09T00:00:00Z')).toThrow();
    store.reserveModelCall({ ...reservation, day: '2026-11-10' });
    store.close();
    const restarted = open();
    expect(restarted.getModelCallCount('2026-11-09')).toBe(1);
    expect(restarted.getModelCallCount('2026-11-10')).toBe(1);
    expect(restarted.getModelCallCount('2026-11-11')).toBe(0);
  });

  it('rolls back budget reservation on ledger capacity and does not refund on request completion', () => {
    const store = open({ records: 2 });
    store.submitRequest(input);
    store.reserveModelCall({ day: '2026-11-09', callId: 'one', limit: 20 });
    expect(() => store.reserveModelCall({ day: '2026-11-09', callId: 'two', limit: 20 })).toThrow(/capacity/i);
    expect(store.getModelCallCount('2026-11-09')).toBe(1);
    expect(() => store.completeRequest(store.listPendingRequests()[0]!.key, output)).toThrow(/capacity/i);
    expect(store.getModelCallCount('2026-11-09')).toBe(1);
  });

  it('enforces daily model budgets across real producers with distinct and duplicate call IDs', async () => {
    const [first, second] = await Promise.all([startChild(), startChild()]);
    const same = { day: '2026-11-09', callId: 'same', limit: 1 };
    const results = await Promise.all([send(first, { action: 'reserve', input: same }), send(second, { action: 'reserve', input: same })]);
    expect(results.every(result => (result as { result?: unknown }).result)).toBe(true);
    const distinct = await Promise.all([send(first, { action: 'reserve', input: { ...same, day: '2026-11-10', callId: 'first' } }),
      send(second, { action: 'reserve', input: { ...same, day: '2026-11-10', callId: 'second' } })]);
    expect(distinct.filter(result => (result as { result?: unknown }).result)).toHaveLength(1);
    expect(distinct.filter(result => (result as { error?: string }).error?.includes('budget'))).toHaveLength(1);
    expect(open().getModelCallCount('2026-11-10')).toBe(1);
  });

  it('persists stable requests, evidence, handoff and processing receipts across restart', () => {
    const store = open();
    const entry = store.submitRequest(input);
    expect(store.submitRequest(input).key).toBe(entry.key);
    expect(() => store.submitRequest({ ...input, request: { ...request, reason: 'correction' } })).toThrow(/same key|content/i);
    expect(() => store.submitRequest({ ...input, evidence: [{ ...evidence, digest: 'd'.repeat(64) }] })).toThrow(/same key|content/i);
    store.markHandedOff(entry.key, 'delivery:1');
    expect(store.listPendingRequests()).toHaveLength(0);
    const receipt = store.completeRequest(entry.key, output);
    expect(receipt.candidateIds).toHaveLength(1);
    expect(store.completeRequest(entry.key, output)).toEqual(receipt);
    expect(() => store.completeRequest(entry.key, { ...output, warnings: ['changed'] })).toThrow(/content|digest/i);
    store.close();
    const restarted = open();
    expect(restarted.getProcessingReceipt(entry.key)).toEqual(receipt);
    expect(restarted.getRequest(entry.key)?.handoff?.deliveryKey).toBe('delivery:1');
    expect(restarted.getRequest(entry.key)?.evidence).toEqual([evidence]);
    expect(restarted.listCandidates()).toHaveLength(1);
  });

  it('retains visible source blocking and rejects model state, unbound evidence and wrong scopes atomically', () => {
    const store = open();
    const blocked = store.submitRequest({ request, evidence: [], blockedReason: 'source unavailable' });
    expect(store.getRequest(blocked.key)?.blockedReason).toBe('source unavailable');
    expect(() => store.completeRequest(blocked.key, output)).toThrow(/blocked/i);
    const entry = store.submitRequest({ ...input, request: { ...request, sourceId: 'run:r2' } });
    for (const proposal of [{ ...output.candidates[0], state: 'validated' }, { ...output.candidates[0], evidenceIds: ['missing'] },
      { ...output.candidates[0], applicability: { ...output.candidates[0]!.applicability, project: 'github:other/api' } }]) {
      expect(() => store.completeRequest(entry.key, { ...output, candidates: [proposal] })).toThrow();
    }
    expect(store.getProcessingReceipt(entry.key)).toBeUndefined();
    expect(store.listCandidates()).toEqual([]);
    store.close();
    expect(open().getRequest(blocked.key)?.blockedReason).toBe('source unavailable');
  });

  it('atomically advances a scoped run cursor with requests and enforces optimistic cursor checks', () => {
    const store = open({ pendingRequests: 1 });
    store.commitScan(scan);
    expect(store.getScanCursor(scan)).toEqual(scan.cursor);
    const next = { ...scan, expectedCursor: scan.cursor, cursor: { ...scan.cursor, sequence: 2 },
      requests: [{ ...input, request: { ...request, sourceId: 'run:next' } }] };
    expect(() => store.commitScan(next)).toThrow(/capacity/i);
    expect(store.getScanCursor(scan)).toEqual(scan.cursor);
    expect(store.listPendingRequests()).toHaveLength(1);
    expect(() => store.commitScan(scan)).toThrow(/cursor|version/i);
    expect(() => store.commitScan({ ...next, requests: [{ ...input, request: { ...request, sourceRunId: 'other' } }] })).toThrow(/run/i);
    expect(store.getScanCursor({ ...scan, analyzerVersion: '2' })).toBeUndefined();
  });

  it('stores immutable evidence with its request and rolls both back on submit or scan capacity failures', async () => {
    const path = join(root, 'session.txt');
    writeFileSync(path, 'Review before publishing.');
    const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path, allowedRoot: root, format: 'text' }] });
    const submission = { request: { ...request, evidenceDigest: pack.digest }, evidence: pack.entries.map(entry => entry.ref) };
    const store = open({ pendingRequests: 1 });
    const entry = store.submitRequest(submission, pack);
    expect(store.getEvidencePack(pack.digest)).toEqual(pack);
    expect(store.submitRequest(submission, pack).key).toBe(entry.key);
    writeFileSync(path, 'A different verified source.');
    const nextPack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path, allowedRoot: root, format: 'text' }] });
    const next = { request: { ...request, sourceId: 'new-source', evidenceDigest: nextPack.digest }, evidence: nextPack.entries.map(item => item.ref) };
    expect(() => store.submitRequest(next, nextPack)).toThrow(/capacity/i);
    expect(() => store.commitScan({ ...scan, requests: [next] }, [nextPack])).toThrow(/capacity/i);
    expect(store.getEvidencePack(nextPack.digest)).toBeUndefined();
    expect(store.getScanCursor(scan)).toBeUndefined();
    expect(store.listRequests()).toHaveLength(1);
    store.close();
    expect(open().getEvidencePack(pack.digest)).toEqual(pack);
  });

  it('counts pending snapshot bytes and rejects unrelated evidence before committing', async () => {
    const path = join(root, 'large-session.txt');
    writeFileSync(path, 'Review. '.repeat(1000));
    const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path, allowedRoot: root, format: 'text' }] });
    const store = open({ pendingBytes: 4000 });
    expect(() => store.submitRequest(input, pack)).toThrow(/snapshot|evidence/i);
    const submission = { request: { ...request, evidenceDigest: pack.digest }, evidence: pack.entries.map(entry => entry.ref) };
    expect(() => store.submitRequest(submission, pack)).toThrow(/capacity/i);
    expect(store.listRequests()).toEqual([]);
    expect(store.getEvidencePack(pack.digest)).toBeUndefined();
    expect(() => store.commitScan({ ...scan, requests: [] }, [pack])).toThrow(/snapshot|evidence/i);
  });

  it('atomically adds late-source evidence at an unchanged audit cursor without allowing cursor regression', () => {
    const store = open();
    store.commitScan(scan);
    const late = { ...input, request: { ...request, sourceId: 'late-source', evidenceDigest: 'e'.repeat(64) } };
    expect(store.commitScan({ ...scan, expectedCursor: scan.cursor, requests: [late] })).toHaveLength(1);
    expect(store.listRequests()).toHaveLength(2);
    expect(store.getScanCursor(scan)).toEqual(scan.cursor);
    expect(() => store.commitScan({ ...scan, expectedCursor: scan.cursor, requests: [] })).toThrow(/advance/i);
    expect(() => store.commitScan({ ...scan, expectedCursor: scan.cursor, cursor: { ...scan.cursor, head: 'd'.repeat(64) }, requests: [late] })).toThrow(/advance|cursor/i);
  });

  it('blocks rather than evicts active references and accounts for bytes and receipts', () => {
    const store = open({ records: 3 });
    const entry = store.submitRequest(input);
    expect(() => store.completeRequest(entry.key, output)).toThrow(/capacity/i);
    expect(store.getProcessingReceipt(entry.key)).toBeUndefined();
    expect(store.listCandidates()).toEqual([]);
    expect(store.getRequest(entry.key)).toBeDefined();
    store.close();
    const tiny = open({ pendingBytes: 10 });
    expect(() => tiny.submitRequest({ ...input, request: { ...request, sourceId: 'new' } })).toThrow(/capacity/i);
    expect(tiny.getRequest(entry.key)).toBeDefined();
  });

  it.each(['records', 'bytes'] as const)('atomically withdraws sources at the %s admission limit without accepting new work', dimension => {
    const store = open({ records: 5 });
    const entry = store.submitRequest(input);
    const receipt = store.completeRequest(entry.key, output);
    store.reserveModelCall({ day: '2026-11-09', callId: 'fill', limit: 20 });
    const inspect = new sqlite.DatabaseSync(file);
    const bytes = Number(inspect.prepare('SELECT SUM(bytes) AS bytes FROM learning_ledger').get()!.bytes);
    inspect.close();
    store.close();
    const full = open(dimension === 'records' ? { records: 5 } : { recordBytes: bytes });
    expect(() => full.reserveModelCall({ day: '2026-11-09', callId: 'overflow', limit: 20 })).toThrow(/capacity/i);
    expect(full.invalidateRequestSource(entry.key)).toBe(true);
    expect(full.getRequest(entry.key)?.blockedReason).toBe('source_invalidated');
    expect(full.getCandidate(receipt.candidateIds[0])?.state).toBe('conflict');
    expect(full.getCandidateVersions(receipt.candidateIds[0])).toHaveLength(2);
    expect(full.invalidateRequestSource(entry.key)).toBe(false);
    expect(full.getCandidateVersions(receipt.candidateIds[0])).toHaveLength(2);
    expect(() => full.submitRequest({ ...input, request: { ...request, sourceId: 'overflow' } })).toThrow(/capacity/i);
    full.close();
    const restarted = open();
    expect(restarted.getRequest(entry.key)?.blockedReason).toBe('source_invalidated');
    expect(restarted.getCandidate(receipt.candidateIds[0])?.state).toBe('conflict');
  });

  it('uses the bounded reserve only to tighten source state and rolls back incomplete withdrawal', () => {
    const store = open({ records: 1 });
    const entry = store.submitRequest(input);
    store.setRequestBlocked(entry.key, 'source_unstable', null);
    expect(store.getRequest(entry.key)?.blockedReason).toBe('source_unstable');
    expect(() => store.setRequestBlocked(entry.key, null, 'source_unstable')).toThrow(/capacity/i);
    expect(() => store.reserveModelCall({ day: '2026-11-09', callId: 'overflow', limit: 20 })).toThrow(/capacity/i);
    store.close();
    const normal = open();
    normal.setRequestBlocked(entry.key, null, 'source_unstable');
    const receipt = normal.completeRequest(entry.key, output);
    normal.close();
    const reduced = open({ records: 2 });
    expect(() => reduced.invalidateRequestSource(entry.key)).toThrow(/capacity/i);
    expect(reduced.getRequest(entry.key)?.blockedReason).toBeUndefined();
    expect(reduced.getCandidate(receipt.candidateIds[0])?.state).toBe('candidate');
    expect(reduced.getCandidateVersions(receipt.candidateIds[0])).toHaveLength(1);
  });

  it('rolls back source blocking when SQLite rejects the derived conflict version', () => {
    const store = open();
    const entry = store.submitRequest(input);
    const receipt = store.completeRequest(entry.key, output);
    const sabotage = new sqlite.DatabaseSync(file);
    try {
      sabotage.exec(`CREATE TRIGGER reject_conflict_version BEFORE INSERT ON learning_ledger
        WHEN NEW.kind = 'candidate-version' AND json_extract(NEW.payload, '$.state') = 'conflict'
        BEGIN SELECT RAISE(ABORT, 'injected conflict write failure'); END;`);
      expect(() => store.invalidateRequestSource(entry.key)).toThrow(/injected conflict write failure/);
      expect(store.getRequest(entry.key)?.blockedReason).toBeUndefined();
      expect(store.getCandidate(receipt.candidateIds[0])?.state).toBe('candidate');
      expect(store.getCandidateVersions(receipt.candidateIds[0])).toHaveLength(1);
      sabotage.exec('DROP TRIGGER reject_conflict_version');
      expect(store.invalidateRequestSource(entry.key)).toBe(true);
      expect(store.getRequest(entry.key)?.blockedReason).toBe('source_invalidated');
      expect(store.getCandidate(receipt.candidateIds[0])?.state).toBe('conflict');
    } finally { sabotage.close(); }
  });

  it('persists candidate versions, binds validation digests and only publishes through the application journal', () => {
    const store = open();
    const receipt = store.completeRequest(store.submitRequest(input).key, output);
    const candidate = store.getCandidate(receipt.candidateIds[0]!)!;
    expect(candidate.state).toBe('candidate');
    expect(() => store.transitionCandidate(candidate.id, 1, 'validated')).toThrow(/validation/i);
    expect(() => store.transitionCandidate(candidate.id, 1, 'published')).toThrow();
    const validation = { candidateDigest: candidate.digest, evidenceDigest: request.evidenceDigest,
      validatorVersion: 'validator:1', passed: true, results: ['normal passed', 'recovery passed', 'refusal passed'] };
    expect(() => store.recordValidation(candidate.id, 1, { ...validation, evidenceDigest: 'f'.repeat(64) })).toThrow(/digest/i);
    expect(() => store.recordValidation(candidate.id, 1, { ...validation, candidateDigest: 'f'.repeat(64) })).toThrow(/digest/i);
    const validated = store.recordValidation(candidate.id, 1, validation);
    expect(validated.state).toBe('validated');
    expect(() => store.transitionCandidate(candidate.id, 1, 'rejected')).toThrow(/version/i);
    expect(store.getCandidateVersions(candidate.id).map(entry => entry.version)).toEqual([1, 2]);
    const publication = store.preparePublication(candidate.id, 2, { key: 'publish:1', validatorVersion: 'validator:1',
      targetRef: 'wiki:rules/approval', originalDigest: 'c'.repeat(64), targetDigest: 'd'.repeat(64), recoveryRef: 'backup:approval' });
    expect(publication.phase).toBe('prepared');
    expect(() => store.transitionCandidate(candidate.id, 2, 'published')).toThrow(/publication/i);
    expect(() => store.advancePublication(publication.key, 'committed', 'd'.repeat(64))).toThrow(/phase/i);
    store.advancePublication(publication.key, 'applied', 'd'.repeat(64));
    store.close();
    const restarted = open();
    expect(restarted.listUnfinishedPublications()).toHaveLength(1);
    restarted.advancePublication(publication.key, 'committed', 'd'.repeat(64));
    expect(restarted.getCandidate(candidate.id)?.state).toBe('published');
    expect(restarted.getValidation(candidate.id)?.validatorVersion).toBe('validator:1');
    expect(restarted.listUnfinishedPublications()).toEqual([]);
    expect(restarted.advancePublication(publication.key, 'committed', 'd'.repeat(64)).phase).toBe('committed');
  });

  it('records publication conflicts on third party changes without publishing or overwriting', () => {
    const store = open();
    const receipt = store.completeRequest(store.submitRequest(input).key, output);
    const candidate = store.getCandidate(receipt.candidateIds[0]!)!;
    store.recordValidation(candidate.id, 1, { candidateDigest: candidate.digest, evidenceDigest: request.evidenceDigest,
      validatorVersion: '1', passed: true, results: ['passed'] });
    const publication = store.preparePublication(candidate.id, 2, { key: 'p', validatorVersion: '1',
      targetRef: 'wiki:rules', originalDigest: null, targetDigest: 'd'.repeat(64), recoveryRef: 'backup:rules' });
    expect(store.advancePublication(publication.key, 'applied', 'e'.repeat(64)).phase).toBe('conflict');
    expect(store.getCandidate(candidate.id)?.state).toBe('conflict');
    expect(() => store.advancePublication(publication.key, 'applied', 'd'.repeat(64))).toThrow(/phase|conflict/i);
  });

  it.each([undefined, 'skill:afk-qa'])('binds skill publication to the validated payload target and original digest (top-level %s)', targetRef => {
    const store = open();
    const skill = { ...output.candidates[0], targetRef, kind: 'skill', payload: {
      targetSkill: 'skill:afk-qa', originalDigest: 'b'.repeat(64), triggers: ['QA request'], prohibitedConditions: [],
      inputs: [], branches: [], recovery: [], completion: 'QA complete', patch: 'Require independent QA',
      evaluationCases: ['normal', 'recovery', 'refusal'].map(kind => ({ kind, input: 'QA request', expected: 'guarded QA' })),
    } };
    const receipt = store.completeRequest(store.submitRequest(input).key, { ...output, candidates: [skill] });
    const candidate = store.getCandidate(receipt.candidateIds[0]!)!;
    store.recordValidation(candidate.id, 1, { candidateDigest: candidate.digest, evidenceDigest: request.evidenceDigest,
      validatorVersion: 'skill-validator:1', passed: true, results: ['normal, recovery and refusal passed'] });
    const publication = { key: 'skill-publication', validatorVersion: 'skill-validator:1', targetRef: 'skill:afk-qa',
      originalDigest: 'b'.repeat(64), targetDigest: 'd'.repeat(64), recoveryRef: 'backup:afk-qa' };
    expect(() => store.preparePublication(candidate.id, 2, { ...publication, targetRef: 'skill:afk-implement' })).toThrow(/target/i);
    expect(() => store.preparePublication(candidate.id, 2, { ...publication, originalDigest: 'c'.repeat(64) })).toThrow(/digest|version/i);
    expect(() => store.preparePublication(candidate.id, 2, { ...publication, originalDigest: null })).toThrow(/digest|version/i);
    expect(store.getPublication(publication.key)).toBeUndefined();
    expect(store.getCandidate(candidate.id)?.state).toBe('validated');
    const prepared = store.preparePublication(candidate.id, 2, publication);
    for (const change of [{ targetRef: 'skill:afk-implement' }, { originalDigest: 'c'.repeat(64) }]) {
      const legacy = new sqlite.DatabaseSync(file);
      legacy.prepare("UPDATE learning_ledger SET payload = ? WHERE kind = 'publication' AND key = ?")
        .run(JSON.stringify({ ...prepared, ...change }), publication.key);
      legacy.close();
      expect(() => store.advancePublication(publication.key, 'applied', publication.targetDigest)).toThrow(/target|digest|version/i);
      expect(store.getCandidate(candidate.id)?.state).toBe('validated');
    }
    const restored = new sqlite.DatabaseSync(file);
    restored.prepare("UPDATE learning_ledger SET payload = ? WHERE kind = 'publication' AND key = ?")
      .run(JSON.stringify(prepared), publication.key);
    restored.close();
    store.advancePublication(publication.key, 'applied', publication.targetDigest);
    store.advancePublication(publication.key, 'committed', publication.targetDigest);
    expect(store.getCandidate(candidate.id)?.state).toBe('published');
  });

  it('rejects conflicting top-level and skill payload targets even if publication matches the top level', () => {
    const store = open();
    const skill = { ...output.candidates[0], targetRef: 'skill:afk-implement', kind: 'skill', payload: {
      targetSkill: 'skill:afk-qa', originalDigest: 'b'.repeat(64), triggers: ['QA request'], prohibitedConditions: [],
      inputs: [], branches: [], recovery: [], completion: 'QA complete', patch: 'Require independent QA',
      evaluationCases: ['normal', 'recovery', 'refusal'].map(kind => ({ kind, input: 'QA request', expected: 'guarded QA' })),
    } };
    const receipt = store.completeRequest(store.submitRequest(input).key, { ...output, candidates: [skill] });
    const candidate = store.getCandidate(receipt.candidateIds[0]!)!;
    store.recordValidation(candidate.id, 1, { candidateDigest: candidate.digest, evidenceDigest: request.evidenceDigest,
      validatorVersion: 'skill-validator:1', passed: true, results: ['passed'] });
    for (const targetRef of ['skill:afk-implement', 'skill:afk-qa']) {
      expect(() => store.preparePublication(candidate.id, 2, { key: 'conflicting-skill', validatorVersion: 'skill-validator:1',
        targetRef, originalDigest: 'b'.repeat(64), targetDigest: 'd'.repeat(64), recoveryRef: 'backup:afk-qa' })).toThrow(/target/i);
    }
    expect(store.listUnfinishedPublications()).toEqual([]);
    expect(store.getCandidate(candidate.id)?.state).toBe('validated');
  });

  it('selects the successful validation receipt after an earlier failed validator and requires CAS at runtime', () => {
    const store = open();
    const candidate = store.getCandidate(store.completeRequest(store.submitRequest(input).key, output).candidateIds[0]!)!;
    const validation = { candidateDigest: candidate.digest, evidenceDigest: request.evidenceDigest,
      validatorVersion: 'first', passed: false, results: ['failed'] };
    expect(store.recordValidation(candidate.id, 1, validation).state).toBe('candidate');
    expect(() => store.transitionCandidate(candidate.id, undefined as never, 'rejected')).toThrow();
    store.recordValidation(candidate.id, 1, { ...validation, validatorVersion: 'second', passed: true, results: ['passed'] });
    expect(store.getValidation(candidate.id)?.passed).toBe(true);
    expect(() => store.preparePublication(candidate.id, 2, { key: 'p', validatorVersion: 'first',
      targetRef: 'wiki:rules', originalDigest: null, targetDigest: 'd'.repeat(64), recoveryRef: 'backup:rules' })).toThrow(/validation/i);
    expect(store.preparePublication(candidate.id, 2, { key: 'p', validatorVersion: 'second',
      targetRef: 'wiki:rules', originalDigest: null, targetDigest: 'd'.repeat(64), recoveryRef: 'backup:rules' }).phase).toBe('prepared');
  });

  it('rolls back a future failed migration without losing real ledger data', () => {
    const entry = open().submitRequest(input);
    stores[0]!.close();
    expect(() => openSqlite({ file, schema: '', version: 3, migrations: [{ from: 2, to: 3, migrate: database => {
      database.exec('CREATE TABLE migration_probe(value TEXT); DELETE FROM learning_ledger;');
      throw new Error('migration interrupted');
    } }] })).toThrow(/migration interrupted/i);
    const restarted = open();
    expect(restarted.getRequest(entry.key)?.evidence).toEqual([evidence]);
    const check = new sqlite.DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'migration_probe'").get()).toBeUndefined();
    check.close();
  });

  it('preserves version-one requests on upgrade and rejects older writers after inline snapshots are enabled', () => {
    const entry = open().submitRequest(input);
    stores[0]!.close();
    const legacy = new sqlite.DatabaseSync(file);
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();
    expect(open().getRequest(entry.key)?.evidence).toEqual([evidence]);
    expect(() => openSqlite({ file, schema: '', version: 1 })).toThrow(/unsupported.*version/i);
  });

  it('uses private modes and rejects linked database, parent and sqlite sidecar paths', () => {
    const store = open();
    store.submitRequest(input);
    for (const path of [file, `${file}-wal`, `${file}-shm`]) expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(join(root, 'private')).mode & 0o077).toBe(0);
    store.close();
    const alias = join(root, 'alias');
    symlinkSync(join(root, 'private'), alias);
    expect(() => new CandidateStore({ file: join(alias, 'learning.sqlite') })).toThrow(/symlink|symbolic/i);
    const linked = join(root, 'private', 'linked.sqlite');
    symlinkSync(file, linked);
    expect(() => new CandidateStore({ file: linked })).toThrow(/symlink|symbolic/i);
    const hardlink = join(root, 'private', 'hardlink.sqlite');
    linkSync(file, hardlink);
    expect(() => new CandidateStore({ file: hardlink })).toThrow(/regular|private/i);
    rmSync(hardlink);
    symlinkSync(file, `${file}-wal`);
    expect(() => open()).toThrow(/symlink|symbolic/i);
  });

  it.each(['removed', 'recreated', 'symbolic', 'linked', 'persistent', 'database'] as const)(
    'rechecks an unlinked SQLite sidecar without accepting unsafe replacements (%s)', async scenario => {
      open().close();
      const journal = `${file}-journal`;
      const external = join(root, 'external-sentinel');
      if (scenario === 'recreated') writeFileSync(journal, '', { mode: 0o600 });
      if (scenario === 'symbolic') symlinkSync(file, journal);
      if (scenario === 'linked') {
        writeFileSync(external, 'unchanged', { mode: 0o644 });
        linkSync(external, journal);
      }
      const preload = join(root, 'unlinked-sidecar.mjs');
      writeFileSync(preload, [
        "import filesystem from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'const original = filesystem.lstatSync;',
        `const database = ${JSON.stringify(file)};`,
        `const target = ${JSON.stringify(scenario === 'database' ? file : journal)};`,
        'let observed = false;',
        'filesystem.lstatSync = function(path, ...options) {',
        "  if (String(path) === target) process.stderr.write('target-lstat\\n');",
        `  if (String(path) === target && (!observed || ${scenario === 'persistent'})) {`,
        '    observed = true;',
        '    const metadata = Reflect.apply(original, this, [database, ...options]);',
        "    Object.defineProperty(metadata, 'nlink', { value: 0 });",
        '    return metadata;',
        '  }',
        '  return Reflect.apply(original, this, [path, ...options]);',
        '};',
        'syncBuiltinESMExports();',
      ].join('\n'));
      if (scenario === 'removed' || scenario === 'recreated') {
        const child = await startChild(['--import', preload]);
        expect(await send(child, { action: 'submit', input })).toHaveProperty('result');
        expect(open().listRequests()).toHaveLength(1);
      } else {
        await expect(startChild(['--import', preload])).rejects.toThrow(/regular|private|symbolic/i);
        if (scenario === 'linked') {
          expect(childErrors.get(children.at(-1)!)?.match(/target-lstat/g)).toHaveLength(2);
          expect(statSync(file).nlink).toBe(1);
          expect(readFileSync(external, 'utf8')).toBe('unchanged');
          expect(statSync(external).mode & 0o777).toBe(0o644);
        }
      }
    });

  it('refuses a parent directory replaced with a symbolic link after opening', () => {
    const store = open();
    renameSync(join(root, 'private'), join(root, 'moved'));
    symlinkSync(join(root, 'moved'), join(root, 'private'));
    expect(() => store.submitRequest(input)).toThrow(/symbolic|symlink/i);
  });

  it('preserves existing database and schema when initialization or migration fails', () => {
    open().close();
    const database = new sqlite.DatabaseSync(file);
    database.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'keep\'); PRAGMA user_version = 0;');
    database.close();
    expect(() => open()).toThrow();
    const check = new sqlite.DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    expect(check.prepare('SELECT value FROM sentinel').get()?.value).toBe('keep');
    check.exec('PRAGMA user_version = 999');
    check.close();
    const before = readFileSync(file);
    expect(() => open()).toThrow(/version/i);
    expect(readFileSync(file)).toEqual(before);
    chmodSync(file, 0o600);
  });

  it('deduplicates real simultaneous producers and rejects different content under the same key', async () => {
    const [first, second] = await Promise.all([startChild(), startChild()]);
    const results = await Promise.all([send(first, { action: 'submit', input }), send(second, { action: 'submit', input })]);
    expect(results.every(result => (result as { result?: unknown }).result)).toBe(true);
    expect(open().listPendingRequests()).toHaveLength(1);
    const conflict = await send(second, { action: 'submit', input: { ...input, request: { ...request, reason: 'correction' } } });
    expect(conflict).toEqual({ error: expect.stringMatching(/same key|content/i) });
  });

  it('atomically deduplicates snapshots submitted by independent producer processes', async () => {
    const path = join(root, 'shared-session.txt');
    writeFileSync(path, 'Independent approval is required.');
    const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path, allowedRoot: root, format: 'text' }] });
    const submission = { request: { ...request, evidenceDigest: pack.digest }, evidence: pack.entries.map(entry => entry.ref) };
    const [first, second] = await Promise.all([startChild(), startChild()]);
    const results = await Promise.all([send(first, { action: 'submit', input: submission, snapshot: pack }),
      send(second, { action: 'submit', input: submission, snapshot: pack })]);
    expect(results.every(result => (result as { result?: unknown }).result)).toBe(true);
    const store = open();
    expect(store.listRequests()).toHaveLength(1);
    expect(store.getEvidencePack(pack.digest)).toEqual(pack);
  });

  it('cold-starts sixty independent process pairs against fresh ledgers without losing either producer', async () => {
    for (let iteration = 0; iteration < 60; iteration++) {
      file = join(root, `cold-${iteration}`, 'learning.sqlite');
      const [first, second] = await Promise.all([startChild(), startChild()]);
      const results = await Promise.all([send(first, { action: 'submit', input }), send(second, { action: 'submit', input })]);
      expect(results.every(result => (result as { result?: unknown }).result), `cold-start pair ${iteration}`).toBe(true);
      const check = open();
      expect(check.listRequests()).toHaveLength(1);
      check.close();
      await Promise.all([first, second].map(child => new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      })));
    }
  });

  it('serializes independent process cursor and candidate version races', async () => {
    const [first, second] = await Promise.all([startChild(), startChild()]);
    const scans = await Promise.all([send(first, { action: 'scan', input: scan }), send(second, { action: 'scan', input: scan })]);
    expect(scans.filter(result => (result as { result?: unknown }).result)).toHaveLength(1);
    expect(scans.filter(result => (result as { error?: string }).error?.includes('cursor'))).toHaveLength(1);
    const store = open();
    const receipt = store.completeRequest(store.listPendingRequests()[0]!.key, output);
    const races = await Promise.all([send(first, { action: 'transition', id: receipt.candidateIds[0], version: 1, state: 'rejected' }),
      send(second, { action: 'transition', id: receipt.candidateIds[0], version: 1, state: 'conflict' })]);
    expect(races.filter(result => (result as { result?: unknown }).result)).toHaveLength(1);
    expect(races.filter(result => (result as { error?: string }).error?.includes('version'))).toHaveLength(1);
    expect(store.getCandidateVersions(receipt.candidateIds[0]!)).toHaveLength(2);
  });

  it.each(['scan', 'complete'] as const)('rolls back %s when a real process dies before COMMIT', async action => {
    const store = open();
    const entry = action === 'complete' ? store.submitRequest(input) : undefined;
    const child = await startChild();
    expect(await send(child, { action, input: action === 'scan' ? scan : output, key: entry?.key, pauseBeforeCommit: true })).toBe('before-commit');
    const probe = new sqlite.DatabaseSync(file);
    try {
      probe.exec('PRAGMA busy_timeout = 50');
      expect(() => probe.exec('BEGIN IMMEDIATE')).toThrow(/locked/i);
    } finally { probe.close(); }
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exit;
    store.close();
    const restarted = open();
    if (action === 'scan') {
      expect(restarted.getScanCursor(scan)).toBeUndefined();
      expect(restarted.listRequests()).toEqual([]);
    } else {
      expect(restarted.getRequest(entry!.key)).toBeDefined();
      expect(restarted.getProcessingReceipt(entry!.key)).toBeUndefined();
      expect(restarted.listCandidates()).toEqual([]);
      expect(restarted.completeRequest(entry!.key, output).candidateIds).toHaveLength(1);
    }
  });

  it('survives SIGKILL after scan commit and candidate commit without duplicate model work', async () => {
    const child = await startChild();
    expect(await send(child, { action: 'scan', input: scan })).toHaveProperty('result');
    const store = open();
    const entry = store.listPendingRequests()[0]!;
    const completed = await send(child, { action: 'complete', key: entry.key, input: output }) as { result: unknown };
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exit;
    store.close();
    const restarted = open();
    expect(restarted.getScanCursor(scan)).toEqual(scan.cursor);
    expect(restarted.getProcessingReceipt(entry.key)).toEqual(completed.result);
    expect(restarted.completeRequest(entry.key, output)).toEqual(completed.result);
    expect(restarted.listCandidates()).toHaveLength(1);
  });
});
