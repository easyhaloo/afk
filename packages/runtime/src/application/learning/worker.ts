import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentProvider } from '../../domain/agents/types.js';
import { DurableTriggerQueue } from '../plugins/trigger-queue.js';
import { buildAnalysisPrompt, parseAnalysisOutput } from './analysis.js';
import { executeAnalysis, type AnalysisExecutionResult } from './analysis-runner.js';
import { CandidateStore, type AnalysisAttempt, type LearningCandidate, type StoredDistillationRequest } from './candidate-store.js';
import { DISTILLATION_LIMITS, distillationRequestSchema, learningScopeSchema, type DistillationOutput, type DistillationRequest } from './contracts.js';
import { loadEvidencePack, saveEvidencePack, validateEvidencePack, type EvidencePack } from './evidence.js';
import { canonicalLearningJson } from './requests.js';

export function learningDirectory(homeDir = homedir()): string {
  return join(homeDir, '.afk', 'learning');
}

export async function submitDistillation(input: {
  directory: string; request: DistillationRequest; pack: EvidencePack;
}): Promise<StoredDistillationRequest> {
  const request = distillationRequestSchema.parse(input.request);
  const pack = validateEvidencePack(input.pack);
  if (pack.digest !== request.evidenceDigest) throw new Error('Request evidence digest differs from snapshot');
  const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
  try {
    await saveEvidencePack(join(input.directory, 'snapshots'), pack);
    return store.submitRequest({ request, evidence: pack.entries.map(entry => entry.ref),
      ...(!pack.entries.length ? { blockedReason: 'evidence_unavailable' } : {}) });
  } finally { store.close(); }
}

export interface LearningJob {
  jobId: string;
  scope: string;
  sourceId: string;
  sourceRunId?: string;
  workItemId?: string;
  status: 'pending' | 'blocked' | 'failed' | 'processed';
  reasonCode?: string;
  attempts: AnalysisAttempt[];
}

export interface LearningState {
  jobs: LearningJob[];
  candidates: LearningCandidate[];
}

export interface LearningWorkerResult {
  processed: number;
  pending: number;
  blocked: number;
}

export function queryLearningState(input: { directory: string; scope: string }): LearningState {
  const scope = learningScopeSchema.parse(input.scope);
  const file = join(input.directory, 'candidates.sqlite');
  if (!existsSync(file)) return { jobs: [], candidates: [] };
  const store = new CandidateStore({ file });
  try {
    const jobs = store.listRequests().filter(entry => entry.request.scope === scope).map(entry => ({
      jobId: entry.key, scope, sourceId: entry.request.sourceId, sourceRunId: entry.request.sourceRunId,
      workItemId: entry.request.workItemId,
      status: store.getProcessingReceipt(entry.key) ? 'processed' as const : entry.blockedReason
        ? ['analysis_invalid_output', 'analysis_failed', 'attempts_exhausted'].includes(entry.blockedReason) ? 'failed' as const : 'blocked' as const
        : 'pending' as const,
      ...(entry.blockedReason ? { reasonCode: entry.blockedReason } : {}),
      attempts: store.listAnalysisAttempts(entry.key),
    }));
    return { jobs, candidates: store.listCandidates().filter(entry => entry.proposal.applicability.project === scope) };
  } finally { store.close(); }
}

export interface LearningWorkerOptions {
  directory: string;
  enabled: boolean;
  provider: AgentProvider;
  dailyCalls?: number;
  timeoutMs?: number;
  analyze?: typeof executeAnalysis;
}

const deliverySchema = z.object({ jobId: z.string().regex(/^[a-f0-9]{64}$/), scope: learningScopeSchema }).strict();

export class LearningWorker {
  private readonly store: CandidateStore;
  private readonly queue: DurableTriggerQueue;
  private readonly dailyCalls: number;
  private active?: AbortController;
  private closing?: Promise<void>;

  constructor(private readonly options: LearningWorkerOptions) {
    this.dailyCalls = z.number().int().nonnegative().max(10000).parse(options.dailyCalls ?? DISTILLATION_LIMITS.dailyCalls);
    z.boolean().parse(options.enabled);
    this.store = new CandidateStore({ file: join(options.directory, 'candidates.sqlite') });
    try {
      this.queue = new DurableTriggerQueue(join(options.directory, 'distillation-queue.sqlite'), delivery => this.process(delivery),
        { maxAttempts: DISTILLATION_LIMITS.attempts, retryDelayMs: 1000,
          maxRecords: DISTILLATION_LIMITS.pendingRequests, maxBytes: DISTILLATION_LIMITS.pendingBytes });
    } catch (error) { this.store.close(); throw error; }
  }

  async runOnce(): Promise<LearningWorkerResult> {
    this.assertEnabled();
    this.handoff();
    this.queue.start();
    await this.queue.close();
    const requests = this.store.listRequests();
    return {
      processed: requests.filter(entry => this.store.getProcessingReceipt(entry.key)).length,
      pending: requests.filter(entry => !entry.blockedReason && !this.store.getProcessingReceipt(entry.key)).length,
      blocked: requests.filter(entry => entry.blockedReason && !this.store.getProcessingReceipt(entry.key)).length,
    };
  }

  async watch(signal: AbortSignal): Promise<void> {
    this.assertEnabled();
    this.queue.start();
    try {
      while (!signal.aborted) {
        this.handoff();
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 1000);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally { await this.close(); }
  }

  close(): Promise<void> {
    this.active?.abort();
    return this.closing ??= (async () => {
      try { await this.queue.close({ drain: false }); }
      finally { this.store.close(); }
    })();
  }

  private assertEnabled(): void {
    if (!this.options.enabled) throw new Error('learning_disabled');
    if (this.closing) throw new Error('learning_worker_closed');
  }

  private handoff(): void {
    for (const entry of this.store.listPendingRequests()) {
      const delivery = this.queue.enqueue('learning.distill', JSON.stringify({ jobId: entry.key, scope: entry.request.scope }), entry.key);
      this.store.markHandedOff(entry.key, delivery.deliveryId);
    }
  }

  private async process(delivery: { deliveryId: string; providerId: string; body: string }): Promise<void> {
    const { jobId, scope } = deliverySchema.parse(JSON.parse(delivery.body));
    const entry = this.store.getRequest(jobId);
    if (!entry || entry.request.scope !== scope || delivery.providerId !== 'learning.distill') throw new Error('learning_request_not_found');
    if (this.store.getProcessingReceipt(jobId)) return;
    const fail = (code: string): never => {
      this.store.setRequestBlocked(jobId, code);
      throw new Error(code);
    };
    if ((this.queue.status(delivery.deliveryId)[0]?.attempts ?? 0) > DISTILLATION_LIMITS.attempts) fail('attempts_exhausted');
    const attempts = this.store.listAnalysisAttempts(jobId);
    if (attempts.some(attempt => attempt.status === 'started')) fail('analysis_outcome_unknown');
    if (attempts.length >= DISTILLATION_LIMITS.attempts) fail('attempts_exhausted');
    let pack: EvidencePack;
    try {
      pack = await loadEvidencePack(join(this.options.directory, 'snapshots'), entry.request.evidenceDigest);
      const refs = [...pack.entries.map(item => item.ref)].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      if (canonicalLearningJson(refs) !== canonicalLearningJson(entry.evidence)) throw new Error();
    } catch { return fail('evidence_unavailable'); }
    const day = new Date().toISOString().slice(0, 10);
    const callId = randomUUID();
    try { this.store.startAnalysisAttempt({ requestKey: jobId, day, callId, limit: this.dailyCalls, startedAt: new Date().toISOString() }); }
    catch {
      return fail(this.store.getModelCallCount(day) >= this.dailyCalls ? 'budget_exhausted' : 'storage_blocked');
    }
    this.active = new AbortController();
    let result: AnalysisExecutionResult | undefined;
    const finishFailed = (code: string): never => {
      this.store.finishAnalysisAttempt(callId, { status: code === 'analysis_cancelled' ? 'cancelled' : 'failed',
        finishedAt: new Date().toISOString(), errorCode: code, ...(result?.usage ? { usage: result.usage } : {}) });
      return fail(code);
    };
    try {
      try {
        result = await (this.options.analyze ?? executeAnalysis)({ provider: this.options.provider, jobId,
          prompt: buildAnalysisPrompt(pack, entry.request), signal: this.active.signal, timeoutMs: this.options.timeoutMs,
          onStarted: identity => { this.store.recordAnalysisIdentity(callId, identity); } });
        if (result.sessionId) this.store.recordAnalysisIdentity(callId, { analysisRunId: result.analysisRunId, sessionId: result.sessionId });
      } catch (error) {
        const code = error instanceof Error && ['analysis_unsupported', 'analysis_timed_out', 'analysis_cancelled'].includes(error.message)
          ? error.message : 'analysis_failed';
        return finishFailed(code);
      }
      let output: DistillationOutput;
      try { output = parseAnalysisOutput(result.output, entry.request, pack); }
      catch { return finishFailed('analysis_invalid_output'); }
      try { this.store.completeRequest(jobId, output); }
      catch { return finishFailed('storage_blocked'); }
      this.store.finishAnalysisAttempt(callId, { status: 'succeeded', finishedAt: new Date().toISOString(),
        ...(result.usage ? { usage: result.usage } : {}) });
      this.store.setRequestBlocked(jobId, null);
    } finally { this.active = undefined; }
  }
}
