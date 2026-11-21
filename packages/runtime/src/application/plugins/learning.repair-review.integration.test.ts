import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { CandidateStore } from '../learning/candidate-store.js';
import { page, wikiScript } from '../learning/knowledge.fixture.spec.js';
import * as knowledge from '../learning/knowledge.js';
import { createLessonPublicationFixture } from '../learning/lesson-publication.fixture.spec.js';
import { verifyLessonPublication } from '../learning/lesson-publication-guard.js';
import { queryLearningRequest } from '../learning/worker.js';
import { runRepairReviewWorkflow } from '../workflows/run-cmd.js';
import { createLearningPlugin } from './learning.js';
import { PluginRuntime } from './runtime.js';

const analysis = vi.hoisted(() => vi.fn());
vi.mock('../learning/analysis-runner.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/analysis-runner.js')>(), executeAnalysis: analysis,
}));
vi.mock('../../infrastructure/config/manager.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../infrastructure/config/manager.js')>(),
  getWorkflowConfig: () => ({ agentDefault: 'unavailable-agent', workflowHardTimeout: 10000, targetBranch: 'main' }),
}));

const cleanup: Array<() => void> = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function setup() {
  const fixture = await createLessonPublicationFixture({ repair: true, versions: ['repair-v1'], registerCleanup: close => cleanup.push(close) });
  const homeDir = join(fixture.root, 'home');
  mkdirSync(homeDir);
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('AFK_EVENT_STORE_DIR', fixture.events.root);
  vi.stubEnv('AFK_LOG_DIR', join(homeDir, 'logs'));
  vi.spyOn(process, 'cwd').mockReturnValue(fixture.root);
  writeFileSync(join(fixture.vault, 'template.md'), page('{{title}}', '{{knowledge}}'));
  writeFileSync(join(fixture.vault, 'index.md'), page('Index', '[[backlinks]]'));
  writeFileSync(join(fixture.vault, 'backlinks.md'), page('Backlinks', '[[index]]'));
  const directory = join(homeDir, '.afk', 'learning');
  const file = join(directory, 'candidates.sqlite');
  analysis.mockImplementation(async (input: { jobId: string }) => {
    const store = new CandidateStore({ file });
    try {
      const request = store.getRequest(input.jobId)!;
      const pack = store.getEvidencePack(request.request.evidenceDigest)!;
      return { analysisRunId: 'synthetic-repair-analysis', sessionId: 'synthetic-repair-session', output: {
        type: 'goal_complete', distillation: { version: 1, warnings: [], candidates: [{ ...fixture.candidate.proposal,
          evidenceIds: pack.entries.filter(entry => entry.ref.kind === 'audit').map(entry => entry.ref.id) }] },
      } };
    } finally { store.close(); }
  });
  vi.mocked(fixture.provider.verify).mockClear();
  const activate = async () => {
    const runtime = new PluginRuntime();
    runtimes.push(runtime);
    await runtime.activate({ manifest: { id: 'repair-review.local-contract', version: '1.0.0', apiVersion: 1,
      trusted: true, provides: ['agent.provider', 'verification.provider'] }, activate: context => {
      context.registerAgentProvider('claude-code', new ClaudeCodeProvider());
      context.registerVerificationProvider(fixture.provider.id, fixture.provider);
    } });
    await runtime.activate(createLearningPlugin({ homeDir, config: { enabled: true, dailyCalls: 1,
      validation: { configurationFile: fixture.configurationFile },
      knowledge: { wikiScript, grants: [fixture.authorizationFile] } } }));
    return runtime;
  };
  return { fixture, homeDir, directory, file, activate, runtime: await activate() };
}

describe('repair review using real intake, SQLite, Worker, validation and Wiki preview; synthetic analysis and semantic observations', () => {
  it('binds three distinct runs, preserves the exact candidate across restart and prepares without publishing', async () => {
    const input = await setup();
    const options = { plugins: input.runtime, backlogId: input.fixture.workItemId, sourceRunId: 'original-failure',
      checkerId: 'lesson-checker', hardTimeoutMs: 10000 };
    const first = await runRepairReviewWorkflow(options);
    expect(first.success, JSON.stringify(first)).toBe(true);
    const review = first.steps!.review!.output as { requestKey: string;
      prepared: Array<{ candidateId: string; validatedVersion: number; publication: { candidateId: string } }> };
    expect(review.prepared).toHaveLength(1);
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.fixture.provider.verify).toHaveBeenCalledTimes(1);
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.getRequest(review.requestKey)!.request).toMatchObject({ reason: 'failed', sourceRunId: 'original-failure' });
      const prepared = review.prepared[0]!;
      const candidate = store.getCandidate(prepared.candidateId)!;
      expect(candidate).toMatchObject({ state: 'validated', version: prepared.validatedVersion });
      const proof = verifyLessonPublication({ store, candidate, configurationFile: input.fixture.configurationFile, homeDir: input.homeDir });
      expect(proof).toMatchObject({ status: 'current', binding: { repair: {
        failure: { runId: 'original-failure' }, fix: { runId: 'repair-run' } }, qa: { qaRunId: 'independent-qa' } } });
      expect(store.listPublications().every(publication => publication.phase !== 'committed')).toBe(true);
    } finally { store.close(); }
    await input.runtime.close();
    const restarted = await input.activate();
    const replay = await runRepairReviewWorkflow({ ...options, plugins: restarted });
    expect(replay.success).toBe(true);
    expect(replay.steps!.review!.output).toEqual(first.steps!.review!.output);
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.fixture.provider.verify).toHaveBeenCalledTimes(1);
    const state = queryLearningRequest({ directory: input.directory, scope: input.fixture.scope, requestKey: review.requestKey });
    expect(state.candidates.map(candidate => candidate.id)).toEqual(review.prepared.map(candidate => candidate.candidateId));
  });

  it('retries a transient Wiki preview failure after restart without invalidating the lesson or repeating analysis', async () => {
    const input = await setup();
    const options = { plugins: input.runtime, backlogId: input.fixture.workItemId, sourceRunId: 'original-failure',
      checkerId: 'lesson-checker', hardTimeoutMs: 10000 };
    const first = await runRepairReviewWorkflow(options);
    expect(first.success).toBe(true);
    const review = first.steps!.review!.output;
    const store = new CandidateStore({ file: input.file });
    try {
      const candidates = store.listCandidates();
      const publications = store.listPublications();
      const requests = store.listRequests();
      const index = readFileSync(join(input.fixture.vault, 'index.md'));
      await input.runtime.close();
      const restarted = await input.activate();
      const preview = vi.spyOn(knowledge, 'verifyKnowledgePlan').mockRejectedValueOnce(new Error('Temporary Wiki read failure'));
      const failed = await runRepairReviewWorkflow({ ...options, plugins: restarted });
      expect(failed.success).toBe(false);
      expect(failed.steps?.review).toMatchObject({ status: 'failed', summary: expect.stringContaining('Temporary Wiki read failure') });
      expect(store.listCandidates()).toEqual(candidates);
      expect(store.listPublications()).toEqual(publications);
      expect(store.listRequests()).toEqual(requests);
      expect(readFileSync(join(input.fixture.vault, 'index.md'))).toEqual(index);
      preview.mockRestore();
      const retried = await runRepairReviewWorkflow({ ...options, plugins: restarted });
      expect(retried.success).toBe(true);
      expect(retried.steps?.review?.output).toEqual(review);
      expect(analysis).toHaveBeenCalledTimes(1);
      expect(input.fixture.provider.verify).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });

  it('rejects a legacy QA-only checker before capture or model execution', async () => {
    const input = await setup();
    const saved = JSON.parse(readFileSync(input.fixture.configurationFile, 'utf8'));
    delete saved.checkers[0].qa.repair;
    writeFileSync(input.fixture.configurationFile, JSON.stringify(saved), { mode: 0o600 });
    const result = await runRepairReviewWorkflow({ plugins: input.runtime, backlogId: input.fixture.workItemId,
      sourceRunId: 'original-failure', checkerId: 'lesson-checker', hardTimeoutMs: 10000 });
    expect(result.success).toBe(false);
    expect(analysis).not.toHaveBeenCalled();
    expect(input.fixture.provider.verify).not.toHaveBeenCalled();
  });

  it.each(['source', 'workItem', 'roles'] as const)('rejects mismatched %s before capture or model execution', async mismatch => {
    const input = await setup();
    if (mismatch === 'roles') {
      input.fixture.configuration.checkers[0]!.qa.repair!.fix.runId = 'original-failure';
      input.fixture.persistConfiguration();
    }
    const result = await runRepairReviewWorkflow({ plugins: input.runtime,
      backlogId: mismatch === 'workItem' ? `${input.fixture.scope}#20` : input.fixture.workItemId,
      sourceRunId: mismatch === 'source' ? 'repair-run' : 'original-failure', checkerId: 'lesson-checker', hardTimeoutMs: 10000 });
    expect(result.success).toBe(false);
    expect(result.steps?.review).toMatchObject({ status: 'failed', summary: expect.stringContaining('repair_checker_unavailable') });
    expect(analysis).not.toHaveBeenCalled();
    expect(input.fixture.provider.verify).not.toHaveBeenCalled();
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listRequests()).toEqual([]);
      expect(store.listCandidates()).toEqual([]);
      expect(store.listPublications()).toEqual([]);
    } finally { store.close(); }
  });

  it('refuses a prepared lesson after its saved fix audit drifts across restart', async () => {
    const input = await setup();
    const options = { plugins: input.runtime, backlogId: input.fixture.workItemId, sourceRunId: 'original-failure',
      checkerId: 'lesson-checker', hardTimeoutMs: 10000 };
    const first = await runRepairReviewWorkflow(options);
    expect(first.success).toBe(true);
    await input.runtime.close();
    const path = input.fixture.events.pathFor('repair-run');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    const restarted = await input.activate();
    const result = await runRepairReviewWorkflow({ ...options, plugins: restarted });
    expect(result.success).toBe(false);
    expect(result.steps?.review).toMatchObject({ status: 'failed', summary: expect.stringContaining('learning_validation_unavailable') });
    expect(result.steps?.review?.output).toBeUndefined();
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.fixture.provider.verify).toHaveBeenCalledTimes(1);
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listPublications()).toEqual([expect.objectContaining({ phase: 'prepared' })]);
      expect(store.listCandidates()).toEqual([expect.objectContaining({ state: 'validated', version: 2 })]);
    } finally { store.close(); }
  });

  it('publishes only on explicit request, recalls the lesson after restart and withdraws invalidated source knowledge', async () => {
    const input = await setup();
    const result = await runRepairReviewWorkflow({ plugins: input.runtime, backlogId: input.fixture.workItemId,
      sourceRunId: 'original-failure', checkerId: 'lesson-checker', hardTimeoutMs: 10000 });
    expect(result.success).toBe(true);
    const review = result.steps!.review!.output as { requestKey: string; prepared: Array<{ publication: { key: string } }> };
    const query = { scope: input.fixture.scope, prompt: 'duplicate retry', applicability: { version: 'repair-v1' } };
    expect(await input.runtime.getContextProvider('context.knowledge')!.gather(query)).toEqual([]);
    const published = await input.runtime.dispatchSystemAction('learning.knowledge.publish', {
      scope: input.fixture.scope, key: review.prepared[0]!.publication.key,
    });
    expect(published).toMatchObject({ publication: { phase: 'committed' }, experienceProjection: { blocked: [] } });
    const pagePath = join(input.fixture.vault, 'Retry.md');
    expect(readFileSync(pagePath, 'utf8')).toContain('Serialize retry read and write');
    await input.runtime.close();
    const restarted = await input.activate();
    const context = restarted.getContextProvider('context.knowledge')!;
    expect(await context.gather(query)).toEqual([expect.objectContaining({ content: expect.stringContaining('Serialize retry read and write') })]);
    const store = new CandidateStore({ file: input.file });
    try { store.invalidateRequestSource(review.requestKey); }
    finally { store.close(); }
    await restarted.dispatchSystemAction('learning.knowledge.reconcile', { scope: input.fixture.scope });
    expect(await context.gather(query)).toEqual([]);
    expect(readFileSync(pagePath, 'utf8')).toContain('knowledge_status: revoked');
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.fixture.provider.verify).toHaveBeenCalledTimes(1);
  });
});
