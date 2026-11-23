import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { DurableTriggerQueue } from '../plugins/trigger-queue.js';
import { CandidateStore } from './candidate-store.js';
import { buildEvidencePack, saveEvidencePack } from './evidence.js';
import { openSqlite } from '../../infrastructure/storage/sqlite.js';
import { LearningWorker, queryLearningRequest, queryLearningState, submitDistillation } from './worker.js';
import type { AnalysisExecutionInput } from './analysis-runner.js';
import { DISTILLATION_LIMITS, type DistillationRequest } from './contracts.js';

const directories: string[] = [];
const workers: LearningWorker[] = [];
const scope = 'github:acme/api';

async function fixture(reason: DistillationRequest['reason'] = 'completed') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-worker-'));
  directories.push(root);
  const file = join(root, 'session.txt');
  writeFileSync(file, 'User confirmed: require approval before publishing.');
  const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path: file, allowedRoot: root, format: 'text' }] });
  const directory = join(root, 'learning');
  const request = { version: 1 as const, scope, sourceId: 'run:r1', sourceRunId: 'r1', workItemId: `${scope}#42`,
    evidenceDigest: pack.digest, analyzerVersion: '1', reason };
  const analyze = vi.fn(async (_input?: AnalysisExecutionInput) => ({ analysisRunId: 'analysis-1', sessionId: 'analysis-session-1', output: {
    type: 'goal_complete', distillation: { version: 1, warnings: [], candidates: [{
      kind: 'fact', title: 'Publishing approval', statement: 'Approval is required.',
      evidenceIds: [pack.entries[0]!.ref.id], applicability: { project: scope, environments: [], versions: [],
        preconditions: [], exclusions: [], invalidationConditions: ['approval policy changes'] },
      payload: { subject: 'publishing', rule: 'Require approval', classification: 'proposal' },
    }] },
  } }));
  const job = await submitDistillation({ directory, request, pack });
  return { directory, request, pack, analyze, job, file };
}

function worker(input: ConstructorParameters<typeof LearningWorker>[0]) {
  const instance = new LearningWorker(input);
  workers.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of workers.splice(0)) await instance.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('distillation worker', () => {
  it.each([false, true])('records a mixed batch only when tool inputs match their schema (%s)', async validToolInput => {
    const input = await fixture();
    const analyze = async () => {
      const result = await input.analyze();
      const [fact] = result.output.distillation.candidates;
      const tool = { ...fact!, kind: 'tool', title: 'Text formatter', payload: {
        existingTools: [], inputSchema: { type: 'string' }, outputSchema: { type: 'string' }, dependencies: [],
        permissions: [], timeoutMs: 1000, sideEffects: 'none', idempotency: 'Pure computation', recovery: 'Retry the input',
        source: 'export default value => value.toUpperCase()', tests: [
          { kind: 'normal', input: validToolInput ? '"alpha"' : '["alpha"]', expected: '"ALPHA"' },
          { kind: 'normal', input: '"beta"', expected: '"BETA"' },
          { kind: 'refusal', input: 'null', expected: 'Reject non-text input' },
        ],
      } };
      return { ...result, output: { ...result.output, distillation: { ...result.output.distillation, candidates: [fact, tool] } } };
    };
    const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    const result = await instance.runOnce({ scope, requestKey: input.job.key });
    if (validToolInput) {
      expect(result.job.status).toBe('processed');
      expect(result.candidates.map(candidate => candidate.proposal.kind).sort()).toEqual(['fact', 'tool']);
    } else {
      expect(result.job.attempts).toMatchObject([{ status: 'failed', errorCode: 'analysis_invalid_output' }]);
      expect(result.candidates).toEqual([]);
      expect(queryLearningState({ directory: input.directory, scope }).candidates).toEqual([]);
    }
  });

  it('does not retry a changed executable after a Worker restart', async () => {
    const input = await fixture();
    const analyze = vi.fn(async ({ onStarted }: AnalysisExecutionInput) => {
      await onStarted!({ analysisRunId: 'analysis-1', sessionId: 'analysis-session-1' });
      throw new Error('analysis_executable_changed');
    });
    const options = { ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() };
    const target = { scope, requestKey: input.job.key };
    const first = worker(options);
    await first.runOnce(target);
    await first.close();
    const resumed = await worker(options).runOnce(target);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(resumed.job).toMatchObject({ status: 'blocked', reasonCode: 'analysis_executable_changed',
      attempts: [{ status: 'failed', errorCode: 'analysis_executable_changed' }] });
    expect(resumed.candidates).toEqual([]);
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try { expect(store.getModelCallCount(resumed.job.attempts[0]!.day)).toBe(1); } finally { store.close(); }
  });

  it.each(['replay', 'source_invalidated'] as const)('refuses a reserved launch on %s at the Worker startup boundary', async scenario => {
    const input = await fixture();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    const launch = vi.fn();
    const identity = { analysisRunId: 'analysis-1', sessionId: 'analysis-session-1' };
    try {
      const analyze = async ({ onStarted }: AnalysisExecutionInput) => {
        if (scenario === 'source_invalidated') store.setRequestBlocked(input.job.key, scenario);
        await onStarted!(identity);
        launch();
        if (scenario === 'replay') {
          await onStarted!(identity);
          launch();
        }
        return input.analyze();
      };
      const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
      const result = await instance.runOnce({ scope, requestKey: input.job.key });
      expect(launch).toHaveBeenCalledTimes(scenario === 'replay' ? 1 : 0);
      expect(result.job).toMatchObject({ status: 'blocked', canRun: false, reasonCode: scenario === 'replay' ? 'analysis_outcome_unknown' : scenario });
      expect(result.candidates).toEqual([]);
      const attempts = store.listAnalysisAttempts(input.job.key);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.analysisRunId).toBe(scenario === 'replay' ? identity.analysisRunId : undefined);
      expect(store.getModelCallCount(attempts[0]!.day)).toBe(1);
      await instance.close();
      const resumed = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
      expect((await resumed.runOnce({ scope, requestKey: input.job.key })).job).toEqual(result.job);
      expect(store.listAnalysisAttempts(input.job.key)).toEqual(attempts);
    } finally { store.close(); }
  });

  it('keeps an already processed request intact when it completes between reservation and launch', async () => {
    const input = await fixture();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    const launch = vi.fn();
    try {
      const result = await input.analyze();
      const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), analyze: async ({ onStarted }) => {
        store.completeRequest(input.job.key, result.output.distillation);
        await onStarted!({ analysisRunId: result.analysisRunId, sessionId: result.sessionId });
        launch();
        return result;
      } });
      const state = await instance.runOnce({ scope, requestKey: input.job.key });
      expect(launch).not.toHaveBeenCalled();
      expect(state.job.status).toBe('processed');
      expect(state.job.reasonCode).toBeUndefined();
      expect(state.candidates).toHaveLength(1);
      expect(store.listAnalysisAttempts(input.job.key)).toMatchObject([{ status: 'cancelled', errorCode: 'already_processed' }]);
    } finally { store.close(); }
  });

  it('processes only the exact request and leaves prequeued requests for a later global worker', async () => {
    const input = await fixture();
    const same = await submitDistillation({ ...input, request: { ...input.request, sourceId: 'run:r2', sourceRunId: 'r2' } });
    const foreignScope = 'github:other/api';
    const foreign = await submitDistillation({ ...input, request: { ...input.request, scope: foreignScope, workItemId: `${foreignScope}#42` } });
    const queue = new DurableTriggerQueue(join(input.directory, 'distillation-queue.sqlite'), async () => {});
    const deliveries = [same, foreign].map(entry => queue.enqueue('learning.distill', JSON.stringify({ jobId: entry.key, scope: entry.request.scope }), entry.key));
    await queue.close();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      [same, foreign].forEach((entry, index) => store.markHandedOff(entry.key, deliveries[index]!.deliveryId));
      const before = [same, foreign].map(entry => store.getRequest(entry.key));
      const reconcileSources = vi.fn(async () => {});
      const analyze = vi.fn(async ({ jobId }: { jobId: string }) => {
        const result = await input.analyze();
        result.output.distillation.candidates[0]!.applicability.project = jobId === foreign.key ? foreignScope : scope;
        return result;
      });
      const target = { scope, requestKey: input.job.key };
      const instance = worker({ ...input, analyze, reconcileSources, enabled: true, provider: new ClaudeCodeProvider() });
      const result = await instance.runOnce(target);
      expect(result.job).toMatchObject({ jobId: input.job.key, status: 'processed' });
      expect(result.processing?.candidateIds).toEqual(result.candidates.map(candidate => candidate.id));
      expect(result.candidates).toHaveLength(1);
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(reconcileSources).toHaveBeenCalledTimes(1);
      expect(reconcileSources).toHaveBeenCalledWith(target);
      expect([same, foreign].map(entry => store.getRequest(entry.key))).toEqual(before);
      expect([same, foreign].map(entry => store.listAnalysisAttempts(entry.key))).toEqual([[], []]);
      await instance.close();
      const pending = new DurableTriggerQueue(join(input.directory, 'distillation-queue.sqlite'), async () => {});
      expect(deliveries.map(delivery => pending.status(delivery.deliveryId)[0])).toMatchObject([
        { status: 'pending', attempts: 0 }, { status: 'pending', attempts: 0 },
      ]);
      await pending.close();
      const replay = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
      expect(await replay.runOnce(target)).toEqual(result);
      expect(analyze).toHaveBeenCalledTimes(1);
      await replay.close();
      const global = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
      expect(await global.runOnce()).toEqual({ processed: 3, pending: 0, blocked: 0 });
      expect(analyze).toHaveBeenCalledTimes(3);
      expect(queryLearningRequest({ directory: input.directory, scope: foreignScope, requestKey: foreign.key }).candidates)
        .toMatchObject([{ requestKey: foreign.key, proposal: { applicability: { project: foreignScope } } }]);
    } finally { store.close(); }
  });

  it.each(['scope', 'missing', 'malformed'] as const)('rejects a %s target before reconciliation or analysis', async invalid => {
    const input = await fixture();
    const reconcileSources = vi.fn(async () => {});
    const instance = worker({ ...input, reconcileSources, enabled: true, provider: new ClaudeCodeProvider() });
    const target = { scope: invalid === 'scope' ? 'github:other/api' : scope,
      requestKey: invalid === 'missing' ? '0'.repeat(64) : invalid === 'malformed' ? 'bad' : input.job.key };
    await expect(instance.runOnce(target)).rejects.toThrow();
    expect(reconcileSources).not.toHaveBeenCalled();
    expect(input.analyze).not.toHaveBeenCalled();
    expect(queryLearningState({ directory: input.directory, scope }).jobs[0]).toMatchObject({ status: 'pending', attempts: [] });
  });

  it.each(['source_invalidated', 'budget_exhausted'] as const)('does not drain unrelated deliveries for a %s target', async reason => {
    const input = await fixture();
    const other = await submitDistillation({ ...input, request: { ...input.request, sourceId: 'run:other' } });
    const queue = new DurableTriggerQueue(join(input.directory, 'distillation-queue.sqlite'), async () => {});
    const delivery = queue.enqueue('learning.distill', JSON.stringify({ jobId: other.key, scope }), other.key);
    await queue.close();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      store.markHandedOff(other.key, delivery.deliveryId);
      const before = store.getRequest(other.key);
      if (reason === 'source_invalidated') store.setRequestBlocked(input.job.key, reason);
      const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: reason === 'budget_exhausted' ? 0 : 10 });
      expect(await instance.runOnce({ scope, requestKey: input.job.key })).toMatchObject({
        job: { status: 'blocked', reasonCode: reason, attempts: [] }, candidates: [],
      });
      expect(store.getRequest(other.key)).toEqual(before);
      expect(store.listAnalysisAttempts(other.key)).toEqual([]);
      expect(input.analyze).not.toHaveBeenCalled();
      await instance.close();
      const pending = new DurableTriggerQueue(join(input.directory, 'distillation-queue.sqlite'), async () => {});
      expect(pending.status(delivery.deliveryId)[0]).toMatchObject({ status: 'pending', attempts: 0 });
      await pending.close();
    } finally { store.close(); }
  });

  it('queries only receipt members and rejects corrupt membership instead of using a project-wide candidate', async () => {
    const input = await fixture();
    const target = { directory: input.directory, scope, requestKey: input.job.key };
    expect(queryLearningRequest(target)).toMatchObject({ job: { status: 'pending' }, candidates: [] });
    const other = await submitDistillation({ ...input, request: { ...input.request, sourceId: 'run:other' } });
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    let foreignId: string;
    try {
      const output = (await input.analyze()).output.distillation;
      foreignId = store.completeRequest(other.key, output).candidateIds[0]!;
      store.completeRequest(input.job.key, output);
      expect(queryLearningRequest(target).candidates).toMatchObject([{ requestKey: input.job.key }]);
    } finally { store.close(); }
    const database = openSqlite({ file: join(input.directory, 'candidates.sqlite'), schema: '', version: 2 });
    try {
      for (const candidateIds of [[foreignId], ['0'.repeat(64)], [foreignId, foreignId]]) {
        database.prepare("UPDATE learning_ledger SET payload = ? WHERE kind = 'processing' AND key = ?")
          .run(JSON.stringify({ requestKey: input.job.key, outputDigest: '0'.repeat(64), candidateIds, warnings: [] }), input.job.key);
        expect(() => queryLearningRequest(target)).toThrow('learning_processing_invalid');
      }
    } finally { database.close(); }
  });

  it('upgrades a version-one request and consumes its original private file snapshot', async () => {
    const input = await fixture();
    await saveEvidencePack(join(input.directory, 'snapshots'), input.pack);
    const legacy = openSqlite({ file: join(input.directory, 'candidates.sqlite'), schema: '', version: 2 });
    try { legacy.exec("DELETE FROM learning_ledger WHERE kind = 'snapshot'; PRAGMA user_version = 1;"); }
    finally { legacy.close(); }
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect((await instance.runOnce()).processed).toBe(1);
    expect(input.analyze).toHaveBeenCalledTimes(1);
    expect(queryLearningState({ directory: input.directory, scope }).candidates).toHaveLength(1);
  });

  it.each(['source_invalidated', 'evidence_unavailable'])('refuses an already handed-off delivery blocked by %s before charging or calling analysis', async blockedReason => {
    const input = await fixture();
    const queue = new DurableTriggerQueue(join(input.directory, 'distillation-queue.sqlite'), async () => {});
    const delivery = queue.enqueue('learning.distill', JSON.stringify({ jobId: input.job.key, scope }), input.job.key);
    await queue.close();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      store.markHandedOff(input.job.key, delivery.deliveryId);
      store.setRequestBlocked(input.job.key, blockedReason);
      const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
      expect((await instance.runOnce()).blocked).toBe(1);
      expect(input.analyze).not.toHaveBeenCalled();
      expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(0);
      expect(store.getProcessingReceipt(input.job.key)).toBeUndefined();
      expect(queryLearningState({ directory: input.directory, scope })).toMatchObject({
        candidates: [], jobs: [{ reasonCode: blockedReason, attempts: [] }],
      });
    } finally { store.close(); }
  });

  it('preserves source invalidation when recovering an unfinished old attempt', async () => {
    const input = await fixture();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      store.startAnalysisAttempt({ requestKey: input.job.key, day: new Date().toISOString().slice(0, 10),
        callId: 'invalidated-old-call', limit: 20, startedAt: new Date().toISOString() });
      store.setRequestBlocked(input.job.key, 'source_invalidated');
      const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
      await instance.runOnce();
      expect(input.analyze).not.toHaveBeenCalled();
      expect(store.getRequest(input.job.key)?.blockedReason).toBe('source_invalidated');
      expect(store.listAnalysisAttempts(input.job.key)).toMatchObject([{ status: 'started' }]);
      expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(1);
    } finally { store.close(); }
  });

  it.each([false, true])('does not block a request when another owner claims its attempt before charging (prior failure: %s)', async priorFailure => {
    const input = await fixture();
    const start = CandidateStore.prototype.startAnalysisAttempt;
    if (priorFailure) {
      const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
      try {
        const startedAt = new Date().toISOString();
        store.startAnalysisAttempt({ requestKey: input.job.key, day: startedAt.slice(0, 10), startedAt, callId: 'first-failure', limit: 20 });
        store.finishAnalysisAttempt('first-failure', { status: 'failed', finishedAt: startedAt, errorCode: 'analysis_failed' });
      } finally { store.close(); }
    }
    const race = vi.spyOn(CandidateStore.prototype, 'startAnalysisAttempt').mockImplementationOnce(function (this: CandidateStore, attempt) {
      start.call(this, { ...attempt, callId: 'competing-owner' });
      return start.call(this, attempt);
    });
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    try {
      const result = await instance.runOnce({ scope, requestKey: input.job.key });
      expect(result.job.status).toBe('pending');
      expect(result.job.attempts.filter(attempt => attempt.status === 'started'))
        .toMatchObject([{ callId: 'competing-owner' }]);
      expect(result.job).not.toHaveProperty('reasonCode');
      expect(input.analyze).not.toHaveBeenCalled();
    } finally { race.mockRestore(); }
  });

  it.each([undefined, 'evidence_unavailable', 'source_invalidated'])('keeps its own active attempt distinct from orphan recovery and preserves source blocks (%s)', async blockedReason => {
    const input = await fixture();
    let finish!: (result: Awaited<ReturnType<typeof input.analyze>>) => void;
    const analyze = vi.fn(() => new Promise<Awaited<ReturnType<typeof input.analyze>>>(resolve => { finish = resolve; }));
    const reconcileSources = vi.fn(async () => {});
    const instance = worker({ ...input, analyze, reconcileSources, enabled: true, provider: new ClaudeCodeProvider() });
    const controller = new AbortController();
    const watching = instance.watch(controller.signal);
    try {
      await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
      if (blockedReason) {
        const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
        try { store.setRequestBlocked(input.job.key, blockedReason); } finally { store.close(); }
      }
      await vi.waitFor(() => expect(reconcileSources.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2500 });
      const pending = queryLearningState({ directory: input.directory, scope }).jobs[0];
      expect(pending?.reasonCode).toBe(blockedReason);
      expect(pending?.attempts).toMatchObject([{ status: 'started' }]);
      finish(await input.analyze());
      await vi.waitFor(() => expect(queryLearningState({ directory: input.directory, scope }).jobs[0]?.attempts[0]?.status)
        .toBe(blockedReason ? 'failed' : 'succeeded'));
      const state = queryLearningState({ directory: input.directory, scope });
      expect(state.candidates).toHaveLength(blockedReason ? 0 : 1);
      expect(state.jobs[0]?.reasonCode).toBe(blockedReason);
      expect(analyze).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      finish?.(await input.analyze());
      await watching;
    }
  });

  it.each(['analysis_failed', 'analysis_cancelled'])('preserves source invalidation when active analysis ends with %s', async errorCode => {
    const input = await fixture();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    const analyze = vi.fn(async () => {
      store.setRequestBlocked(input.job.key, 'source_invalidated');
      throw new Error(errorCode);
    });
    try {
      const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
      await instance.runOnce();
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(store.getRequest(input.job.key)?.blockedReason).toBe('source_invalidated');
      expect(store.getProcessingReceipt(input.job.key)).toBeUndefined();
      expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(1);
      expect(store.listAnalysisAttempts(input.job.key)).toMatchObject([{ errorCode }]);
      expect(queryLearningState({ directory: input.directory, scope }).candidates).toEqual([]);
    } finally { store.close(); }
  });

  it('aborts independently of a pending periodic reconciliation and rejects a late successful result', async () => {
    const input = await fixture();
    let finish!: (result: Awaited<ReturnType<typeof input.analyze>>) => void;
    let release!: () => void;
    let analysisSignal: AbortSignal | undefined;
    const analyze = vi.fn((options: { signal?: AbortSignal }) => {
      analysisSignal = options.signal;
      return new Promise<Awaited<ReturnType<typeof input.analyze>>>(resolve => { finish = resolve; });
    });
    const reconcileSources = vi.fn(async () => {
      if (reconcileSources.mock.calls.length === 2) await new Promise<void>(resolve => { release = resolve; });
    });
    const instance = worker({ ...input, analyze, reconcileSources, enabled: true, provider: new ClaudeCodeProvider() });
    const controller = new AbortController();
    const watching = instance.watch(controller.signal);
    try {
      await vi.waitFor(() => expect(reconcileSources).toHaveBeenCalledTimes(2), { timeout: 2500 });
      controller.abort();
      expect(analysisSignal?.aborted).toBe(true);
      finish(await input.analyze());
      await vi.waitFor(() => expect(queryLearningState({ directory: input.directory, scope }).jobs[0]?.attempts[0]?.status)
        .toBe('cancelled'));
      expect(queryLearningState({ directory: input.directory, scope }).candidates).toEqual([]);
      expect(analyze).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      finish?.(await input.analyze());
      release?.();
      await watching;
    }
  });

  it('does not publish a late successful result after cancellation', async () => {
    const input = await fixture();
    const analyze = vi.fn(async (options: { signal?: AbortSignal }) => new Promise<Awaited<ReturnType<typeof input.analyze>>>(resolve => {
      options.signal?.addEventListener('abort', () => { void input.analyze().then(resolve); }, { once: true });
    }));
    const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    const controller = new AbortController();
    const watching = instance.watch(controller.signal);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    controller.abort();
    await watching;
    const state = queryLearningState({ directory: input.directory, scope });
    expect(state.candidates).toEqual([]);
    expect(state.jobs[0]).toMatchObject({ reasonCode: 'analysis_cancelled', attempts: [{ status: 'cancelled' }] });
  });

  it('resumes in watch after the UTC daily budget resets without consuming attempts while blocked', async () => {
    const input = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T23:59:59Z'));
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    store.reserveModelCall({ day: '2026-11-09', callId: 'other-job', limit: 1 });
    store.close();
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: 1 });
    const controller = new AbortController();
    const watching = instance.watch(controller.signal);
    try {
      await vi.waitFor(() => expect(queryLearningState({ directory: input.directory, scope }).jobs[0])
        .toMatchObject({ reasonCode: 'budget_exhausted', attempts: [] }));
      expect(input.analyze).not.toHaveBeenCalled();
      vi.setSystemTime(new Date('2026-11-10T00:00:01Z'));
      await vi.waitFor(() => expect(queryLearningState({ directory: input.directory, scope }).jobs[0]?.status).toBe('processed'),
        { timeout: 2500 });
      expect(input.analyze).toHaveBeenCalledTimes(1);
    } finally { controller.abort(); await watching; }
  });

  it('charges cancelled attempts and permits only the remaining attempt after restart', async () => {
    const input = await fixture();
    const target = { scope, requestKey: input.job.key };
    const cancelled = vi.fn(async () => { throw new Error('analysis_cancelled'); });
    const first = worker({ ...input, analyze: cancelled, enabled: true, provider: new ClaudeCodeProvider() });
    const firstResult = await first.runOnce(target);
    await first.close();
    expect(firstResult.job)
      .toMatchObject({ status: 'blocked', canRun: true, reasonCode: 'analysis_cancelled', attempts: [{ status: 'cancelled' }] });
    const second = worker({ ...input, analyze: cancelled, enabled: true, provider: new ClaudeCodeProvider() });
    expect((await second.runOnce(target)).job).toMatchObject({ status: 'blocked', reasonCode: 'analysis_cancelled', canRun: false });
    expect(cancelled).toHaveBeenCalledTimes(2);
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(2);
      expect(store.listAnalysisAttempts(input.job.key)).toMatchObject([{ status: 'cancelled' }, { status: 'cancelled' }]);
      expect(store.getProcessingReceipt(input.job.key)).toBeUndefined();
    } finally { store.close(); }
  });

  it('does not start queued analyses after shutdown is requested', async () => {
    const input = await fixture();
    await submitDistillation({ ...input, request: { ...input.request, sourceId: 'run:r2' } });
    const analyze = vi.fn(async (options: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('analysis_cancelled')), { once: true });
    }));
    const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    const controller = new AbortController();
    const watching = instance.watch(controller.signal);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const closingAt = Date.now();
    await instance.close();
    controller.abort();
    await watching;
    expect(Date.now() - closingAt).toBeLessThan(5000);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(queryLearningState({ directory: input.directory, scope }).jobs.flatMap(job => job.attempts)).toHaveLength(1);
  });

  it('resumes a budget-blocked request when the budget is available', async () => {
    const input = await fixture();
    const target = { scope, requestKey: input.job.key };
    const exhausted = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: 0 });
    expect((await exhausted.runOnce(target)).job).toMatchObject({ status: 'blocked', reasonCode: 'budget_exhausted', canRun: true, attempts: [] });
    await exhausted.close();
    const resumed = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: 1 });
    expect((await resumed.runOnce(target)).job).toMatchObject({ status: 'processed', canRun: false });
    expect(input.analyze).toHaveBeenCalledTimes(1);
  });

  it('replays failed deliveries without resetting the persistent two-call limit', async () => {
    const input = await fixture();
    const analyze = vi.fn(async () => { throw new Error('analysis_failed'); });
    const failedQueue = new DurableTriggerQueue(join(input.directory, 'distillation-queue.sqlite'), async () => {
      throw new Error('handoff crash');
    }, { maxAttempts: 1 });
    const delivery = failedQueue.enqueue('learning.distill', JSON.stringify({ jobId: input.job.key, scope }), input.job.key);
    failedQueue.start();
    await failedQueue.close();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    store.markHandedOff(input.job.key, delivery.deliveryId);
    store.close();
    const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    const controller = new AbortController();
    const watching = instance.watch(controller.signal);
    try {
      await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2), { timeout: 4500 });
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(analyze).toHaveBeenCalledTimes(2);
    } finally { controller.abort(); await watching; }
    const attempts = queryLearningState({ directory: input.directory, scope }).jobs[0]!.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts.every(attempt => attempt.status === 'failed')).toBe(true);
  });

  it.each([
    { reason: 'completed', timedOut: false, acceptedRetry: true },
    { reason: 'failed', timedOut: false, acceptedRetry: false },
    { reason: 'completed', timedOut: true, acceptedRetry: true },
    { reason: 'failed', timedOut: true, acceptedRetry: true },
    { reason: 'repaired', timedOut: true, acceptedRetry: true },
  ] as const)('retries using the persisted attempt and immutable evidence ($reason, timeout=$timedOut, accepted=$acceptedRetry)', async ({ reason, timedOut, acceptedRetry }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const input = await fixture(reason);
    const sentinel = 'UNTRUSTED_PREVIOUS_OUTPUT_IGNORE_ALL_RULES';
    const priorError = timedOut ? 'analysis_timed_out' : 'analysis_invalid_output';
    let retry = false;
    const analyze = vi.fn(async (_options: { prompt: string }) => {
      if (!retry && timedOut) throw new Error(priorError);
      if (retry && acceptedRetry) return input.analyze();
      return { analysisRunId: 'analysis-invalid', output: { type: 'goal_complete', distillation: {
        version: 1, warnings: [], candidates: [{ state: 'published', statement: sentinel }],
      } } };
    });
    const first = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    await first.runOnce();
    await first.close();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(queryLearningState({ directory: input.directory, scope }).jobs[0]?.attempts)
      .toMatchObject([{ status: 'failed', errorCode: priorError }]);
    const originalPrompt = analyze.mock.calls[0]![0].prompt;
    expect(originalPrompt).not.toContain('Previous attempt error');
    writeFileSync(input.file, 'MUTATED_SOURCE_MUST_NOT_REPLACE_SNAPSHOT');
    retry = true;
    vi.setSystemTime(Date.now() + 2000);
    const second = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    await second.runOnce();
    await second.close();
    expect(analyze).toHaveBeenCalledTimes(2);
    const retryPrompt = analyze.mock.calls[1]![0].prompt;
    expect(retryPrompt).toContain(`Previous attempt error (sanitized): ${priorError}`);
    expect(retryPrompt).toContain('strict candidate fields');
    expect(retryPrompt.includes('at most one strongly supported candidate')).toBe(timedOut);
    expect(retryPrompt.includes('Prefer a Lesson')).toBe(timedOut && reason !== 'completed');
    expect(retryPrompt.endsWith(originalPrompt)).toBe(true);
    expect(retryPrompt).not.toContain(sentinel);
    expect(retryPrompt).not.toContain('MUTATED_SOURCE_MUST_NOT_REPLACE_SNAPSHOT');
    const third = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    await third.runOnce();
    expect(analyze).toHaveBeenCalledTimes(2);
    const state = queryLearningState({ directory: input.directory, scope });
    expect(state.jobs[0]?.attempts).toHaveLength(2);
    expect(state.candidates).toHaveLength(acceptedRetry ? 1 : 0);
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try { expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(2); }
    finally { store.close(); }
  });

  it('awaits reconciliation before runOnce handoff and exposes its errors', async () => {
    const input = await fixture();
    let release!: () => void;
    const reconcileSources = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), reconcileSources });
    const running = instance.runOnce();
    await vi.waitFor(() => expect(reconcileSources).toHaveBeenCalledTimes(1));
    expect(input.analyze).not.toHaveBeenCalled();
    release();
    expect((await running).processed).toBe(1);
    await instance.close();
    const broken = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(),
      reconcileSources: async () => { throw new Error('audit reconciliation failed'); } });
    await expect(broken.runOnce()).rejects.toThrow('audit reconciliation failed');
  });

  it('reconciles watch startup and each cycle, rejects duplicate loops and closes on errors', async () => {
    const input = await fixture();
    const reconcileSources = vi.fn(async () => {
      if (reconcileSources.mock.calls.length === 2) throw new Error('periodic reconciliation failed');
      expect(input.analyze).not.toHaveBeenCalled();
    });
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), reconcileSources });
    const watching = instance.watch(new AbortController().signal);
    const observed = expect(watching).rejects.toThrow('periodic reconciliation failed');
    await expect(instance.runOnce()).rejects.toThrow('learning_worker_running');
    await expect(instance.watch(new AbortController().signal)).rejects.toThrow('learning_worker_running');
    await observed;
    expect(reconcileSources).toHaveBeenCalledTimes(2);
    expect(input.analyze).toHaveBeenCalledTimes(1);
    const replacement = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect((await replacement.runOnce()).processed).toBe(1);
  });

  it('does not hand off after close while reconciliation is still pending', async () => {
    const input = await fixture();
    let release!: () => void;
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(),
      reconcileSources: () => new Promise<void>(resolve => { release = resolve; }) });
    const running = instance.runOnce();
    const observed = expect(running).rejects.toThrow('learning_worker_closed');
    await instance.close();
    release();
    await observed;
    expect(input.analyze).not.toHaveBeenCalled();
  });

  it('processes an immutable snapshot and persists candidates without repeating completed calls', async () => {
    const input = await fixture();
    writeFileSync(input.file, 'Source replaced after request was accepted.');
    const first = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect((await first.runOnce()).processed).toBe(1);
    const state = queryLearningState({ directory: input.directory, scope });
    expect(input.analyze).toHaveBeenCalledTimes(1);
    expect(input.analyze.mock.calls[0]?.[0]?.prompt).toContain('require approval');
    expect(input.analyze.mock.calls[0]?.[0]?.prompt).not.toContain('Source replaced');
    expect(state.jobs).toMatchObject([{ jobId: input.job.key, status: 'processed' }]);
    expect(state.candidates).toMatchObject([{ state: 'candidate', proposal: { kind: 'fact' } }]);
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      expect(store.listAnalysisAttempts(input.job.key)).toMatchObject([{ status: 'succeeded', analysisRunId: 'analysis-1', sessionId: 'analysis-session-1' }]);
      expect(store.listAnalysisAttempts(input.job.key)[0]?.usage).toBeUndefined();
    } finally { store.close(); }
    await first.close();
    const second = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect((await second.runOnce()).processed).toBe(1);
    expect(queryLearningState({ directory: input.directory, scope }).candidates).toHaveLength(1);
    expect(input.analyze).toHaveBeenCalledTimes(1);
    expect(queryLearningState({ directory: input.directory, scope: 'github:other/api' })).toEqual({ jobs: [], candidates: [] });
  });

  it('recovers enqueue-before-handoff crashes through stable delivery keys', async () => {
    const input = await fixture();
    const queue = new DurableTriggerQueue(join(input.directory, 'distillation-queue.sqlite'), async () => {});
    queue.enqueue('learning.distill', JSON.stringify({ jobId: input.job.key, scope }), input.job.key);
    await queue.close();
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect((await instance.runOnce()).processed).toBe(1);
    expect(input.analyze).toHaveBeenCalledTimes(1);
  });

  it('drains accepted deliveries when full and resumes waiting requests after delivery retention', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const input = await fixture();
    const other = await submitDistillation({ ...input, request: { ...input.request, sourceId: 'run:queued' } });
    const [waiting, queued] = input.job.key < other.key ? [input.job, other] : [other, input.job];
    const file = join(input.directory, 'distillation-queue.sqlite');
    const seed = new DurableTriggerQueue(file, async () => {});
    try {
      for (let index = 1; index < DISTILLATION_LIMITS.pendingRequests; index++) {
        seed.enqueue('learning.distill', '{}', `delivered-${index}`);
      }
      seed.start();
    } finally { await seed.close(); }
    const pending = new DurableTriggerQueue(file, async () => {});
    try { pending.enqueue('learning.distill', JSON.stringify({ jobId: queued.key, scope }), queued.key); }
    finally { await pending.close(); }

    const options = { ...input, enabled: true, provider: new ClaudeCodeProvider() };
    const target = { scope, requestKey: waiting.key };
    const selected = worker(options);
    expect(await selected.runOnce(target)).toMatchObject({ job: { status: 'blocked', reasonCode: 'storage_blocked', attempts: [] } });
    await selected.close();
    expect(input.analyze).not.toHaveBeenCalled();

    const global = worker(options);
    expect(await global.runOnce()).toEqual({ processed: 1, pending: 0, blocked: 1 });
    await global.close();
    expect(input.analyze.mock.calls.map(([call]) => call?.jobId)).toEqual([queued.key]);

    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    const resumed = worker(options);
    expect(await resumed.runOnce()).toEqual({ processed: 2, pending: 0, blocked: 0 });
    expect(input.analyze.mock.calls.map(([call]) => call?.jobId)).toEqual([queued.key, waiting.key]);
    const state = queryLearningState({ directory: input.directory, scope });
    expect(new Set(state.candidates.map(candidate => candidate.requestKey))).toEqual(new Set([waiting.key, queued.key]));
  });

  it('rolls back candidates and receipts when the successful attempt cannot commit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
    const input = await fixture();
    const file = join(input.directory, 'candidates.sqlite');
    const database = openSqlite({ file, schema: '', version: 2 });
    try {
      database.exec(`CREATE TRIGGER reject_analysis_success BEFORE UPDATE ON learning_ledger
        WHEN NEW.kind = 'analysis-attempt' AND json_extract(NEW.payload, '$.status') = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'analysis completion interrupted'); END;`);
    } finally { database.close(); }
    const first = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect(await first.runOnce()).toEqual({ processed: 0, pending: 0, blocked: 1 });
    await first.close();
    expect(queryLearningState({ directory: input.directory, scope })).toMatchObject({
      candidates: [], jobs: [{ status: 'blocked', reasonCode: 'storage_blocked',
        attempts: [{ status: 'failed', errorCode: 'storage_blocked' }] }],
    });
    expect(input.analyze).toHaveBeenCalledTimes(1);
    const recovered = openSqlite({ file, schema: '', version: 2 });
    try { recovered.exec('DROP TRIGGER reject_analysis_success'); } finally { recovered.close(); }
    vi.setSystemTime(Date.now() + 2000);
    const second = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect((await second.runOnce()).processed).toBe(1);
    expect(input.analyze).toHaveBeenCalledTimes(2);
    const state = queryLearningState({ directory: input.directory, scope });
    expect(state.candidates).toHaveLength(1);
    expect(state.jobs[0]?.attempts.map(attempt => attempt.status).sort()).toEqual(['failed', 'succeeded']);
    const store = new CandidateStore({ file });
    try { expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(2); }
    finally { store.close(); }
  });

  it('does not call models while disabled or after budget exhaustion', async () => {
    const input = await fixture();
    const disabled = worker({ ...input, enabled: false, provider: new ClaudeCodeProvider() });
    await expect(disabled.runOnce()).rejects.toThrow('learning_disabled');
    expect(input.analyze).not.toHaveBeenCalled();
    await disabled.close();
    const exhausted = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: 0 });
    expect((await exhausted.runOnce()).blocked).toBe(1);
    expect(queryLearningState({ directory: input.directory, scope }).jobs[0]).toMatchObject({ status: 'blocked', reasonCode: 'budget_exhausted' });
    expect(input.analyze).not.toHaveBeenCalled();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try { expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(0); }
    finally { store.close(); }
  });

  it('rejects forged output, preserves the request and charges an attempted call', async () => {
    const input = await fixture();
    const analyze = vi.fn(async () => ({ analysisRunId: 'analysis-invalid', output: {
      type: 'goal_complete', distillation: { version: 1, warnings: [], candidates: [{ state: 'published' }] },
    } }));
    const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    await instance.runOnce();
    const state = queryLearningState({ directory: input.directory, scope });
    expect(state.candidates).toEqual([]);
    expect(state.jobs[0]).toMatchObject({ status: 'failed', reasonCode: 'analysis_invalid_output' });
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      expect(store.getProcessingReceipt(input.job.key)).toBeUndefined();
      expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(1);
      expect(store.listAnalysisAttempts(input.job.key)).toMatchObject([{ status: 'failed', errorCode: 'analysis_invalid_output' }]);
    } finally { store.close(); }
  });

  it('blocks an unfinished prior attempt without guessing its outcome or making another call', async () => {
    const input = await fixture();
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      store.startAnalysisAttempt({ requestKey: input.job.key, callId: 'prior-call', day: new Date().toISOString().slice(0, 10),
        startedAt: new Date().toISOString(), limit: 20 });
    } finally { store.close(); }
    const instance = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    await instance.runOnce();
    expect(input.analyze).not.toHaveBeenCalled();
    expect(queryLearningState({ directory: input.directory, scope }).jobs[0]).toMatchObject({ status: 'blocked', reasonCode: 'analysis_outcome_unknown' });
  });

  it.skipIf(process.platform === 'win32')('recovers the queue after SIGKILL without retrying or refunding an uncertain analysis', async () => {
    const input = await fixture();
    const script = join(input.directory, 'crash-worker.mjs');
    await build({ stdin: { contents: `
      import { LearningWorker } from './worker.js';
      import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
      const [directory, scope, requestKey] = process.argv.slice(2);
      const worker = new LearningWorker({ directory, enabled: true, provider: new ClaudeCodeProvider(),
        analyze: async ({ onStarted }) => {
          onStarted({ analysisRunId: 'crash-run', sessionId: 'crash-session' });
          await new Promise(() => {
            setInterval(() => {}, 1000);
            process.send('analysis-started');
          });
        },
      });
      await worker.runOnce({ scope, requestKey });
    `, resolveDir: fileURLToPath(new URL('.', import.meta.url)) }, outfile: script,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    banner: { js: 'import { createRequire as createFixtureRequire } from "node:module"; const require = createFixtureRequire(import.meta.url);' } });
    const child = fork(script, [input.directory, scope, input.job.key], { execArgv: [], env: {} });
    const closed = once(child, 'close');
    const waitForStart = AbortSignal.timeout(10000);
    let other;
    try {
      const [message] = await Promise.race([
        once(child, 'message', { signal: waitForStart }),
        closed.then(status => { throw new Error(`Worker exited before analysis: ${status.join(', ')}`); }),
      ]);
      expect(message).toBe('analysis-started');
      expect(() => new LearningWorker({ ...input, enabled: true, provider: new ClaudeCodeProvider() })).toThrow(/owner|consumer|already/i);
      other = await submitDistillation({ ...input, request: { ...input.request, sourceId: 'run:accepted-during-analysis' } });
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    expect(await closed).toEqual([null, 'SIGKILL']);
    const target = { directory: input.directory, scope, requestKey: input.job.key };
    const [attempt] = queryLearningRequest(target).job.attempts;
    expect(attempt).toMatchObject({ status: 'started', analysisRunId: 'crash-run', sessionId: 'crash-session' });
    const restarted = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: 2 });
    expect(await restarted.runOnce()).toEqual({ processed: 1, pending: 0, blocked: 1 });
    expect(input.analyze.mock.calls.map(([call]) => call?.jobId)).toEqual([other.key]);
    expect(queryLearningRequest(target)).toMatchObject({ job: { status: 'blocked', reasonCode: 'analysis_outcome_unknown',
      attempts: [attempt] }, candidates: [] });
    const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
    try {
      const [otherAttempt] = store.listAnalysisAttempts(other.key);
      expect(otherAttempt).toMatchObject({ status: 'succeeded' });
      expect(store.getModelCallCount(attempt!.day)).toBe(otherAttempt!.day === attempt!.day ? 2 : 1);
    } finally { store.close(); }
  });

  it('rejects a second live consumer while allowing concurrent producers', async () => {
    const input = await fixture();
    worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() });
    expect(() => worker({ ...input, enabled: true, provider: new ClaudeCodeProvider() })).toThrow(/owner|consumer|already/i);
    expect((await submitDistillation(input)).key).toBe(input.job.key);
  });

  it('stops a running analysis on shutdown and retains the request for recovery', async () => {
    const input = await fixture();
    const analyze = vi.fn(async (options: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('analysis_cancelled')), { once: true });
    }));
    const instance = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    const controller = new AbortController();
    const watching = instance.watch(controller.signal);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    controller.abort();
    await watching;
    expect(queryLearningState({ directory: input.directory, scope }).jobs[0]?.status).not.toBe('processed');
  });
});
