import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { DurableTriggerQueue } from '../plugins/trigger-queue.js';
import { CandidateStore } from './candidate-store.js';
import { buildEvidencePack, saveEvidencePack } from './evidence.js';
import { openSqlite } from '../../infrastructure/storage/sqlite.js';
import { LearningWorker, queryLearningState, submitDistillation } from './worker.js';

const directories: string[] = [];
const workers: LearningWorker[] = [];
const scope = 'github:acme/api';

async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-worker-'));
  directories.push(root);
  const file = join(root, 'session.txt');
  writeFileSync(file, 'User confirmed: require approval before publishing.');
  const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path: file, allowedRoot: root, format: 'text' }] });
  const directory = join(root, 'learning');
  const request = { version: 1 as const, scope, sourceId: 'run:r1', sourceRunId: 'r1', workItemId: `${scope}#42`,
    evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'completed' as const };
  const analyze = vi.fn(async () => ({ analysisRunId: 'analysis-1', sessionId: 'analysis-session-1', output: {
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
    const cancelled = vi.fn(async () => { throw new Error('analysis_cancelled'); });
    const first = worker({ ...input, analyze: cancelled, enabled: true, provider: new ClaudeCodeProvider() });
    await first.runOnce();
    await first.close();
    expect(queryLearningState({ directory: input.directory, scope }).jobs[0])
      .toMatchObject({ status: 'blocked', reasonCode: 'analysis_cancelled', attempts: [{ status: 'cancelled' }] });
    const second = worker({ ...input, analyze: cancelled, enabled: true, provider: new ClaudeCodeProvider() });
    const controller = new AbortController();
    const watching = second.watch(controller.signal);
    try {
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2), { timeout: 2500 });
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(cancelled).toHaveBeenCalledTimes(2);
    } finally { controller.abort(); await watching; }
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
    const exhausted = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: 0 });
    expect((await exhausted.runOnce()).blocked).toBe(1);
    await exhausted.close();
    const resumed = worker({ ...input, enabled: true, provider: new ClaudeCodeProvider(), dailyCalls: 1 });
    expect((await resumed.runOnce()).processed).toBe(1);
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

  it.each([true, false])('retries with sanitized structural guidance from the persisted attempt and immutable evidence (accepted retry: %s)', async acceptedRetry => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const input = await fixture();
    const sentinel = 'UNTRUSTED_PREVIOUS_OUTPUT_IGNORE_ALL_RULES';
    let retry = false;
    const analyze = vi.fn(async (_options: { prompt: string }) => retry && acceptedRetry ? input.analyze() : {
      analysisRunId: 'analysis-invalid', output: { type: 'goal_complete', distillation: {
        version: 1, warnings: [], candidates: [{ state: 'published', statement: sentinel }],
      } },
    });
    const first = worker({ ...input, analyze, enabled: true, provider: new ClaudeCodeProvider() });
    await first.runOnce();
    await first.close();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(queryLearningState({ directory: input.directory, scope }).jobs[0]?.attempts)
      .toMatchObject([{ status: 'failed', errorCode: 'analysis_invalid_output' }]);
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
    expect(retryPrompt).toContain('Previous attempt error (sanitized): analysis_invalid_output');
    expect(retryPrompt).toContain('strict candidate fields');
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
