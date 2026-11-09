import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { DurableTriggerQueue } from '../plugins/trigger-queue.js';
import { CandidateStore } from './candidate-store.js';
import { buildEvidencePack } from './evidence.js';
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
});

describe('distillation worker', () => {
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
