import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { LearningCandidate } from '../learning/candidate-store.js';
import { LearningReviewIncompleteError } from '../learning/contracts.js';
import type { LearningRequestState } from '../learning/worker.js';
import { SystemActionExecutor } from '../workflows/system-actions.js';
import { createLearningPlugin, type LearningConfiguration } from './learning.js';
import { PluginRuntime } from './runtime.js';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), query: vi.fn(), queryAll: vi.fn(), worker: vi.fn(), runOnce: vi.fn(), closeWorker: vi.fn(),
  validate: vi.fn(), prepare: vi.fn(), publish: vi.fn(), reconcileKnowledge: vi.fn(), reconcileLessons: vi.fn(),
  store: vi.fn(), closeStore: vi.fn(), processGuard: vi.fn(), lessonGuard: vi.fn(),
}));

vi.mock('../learning/intake.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/intake.js')>(), reconcileDistillationSources: mocks.capture,
}));
vi.mock('../learning/worker.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/worker.js')>(),
  LearningWorker: mocks.worker, queryLearningRequest: mocks.query, queryLearningState: mocks.queryAll,
}));
vi.mock('../learning/validation-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/validation-runtime.js')>(), validateConfiguredLearningCandidate: mocks.validate,
}));
vi.mock('../learning/knowledge-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/knowledge-runtime.js')>(),
  prepareConfiguredKnowledge: mocks.prepare, publishConfiguredKnowledge: mocks.publish,
  reconcileConfiguredKnowledge: mocks.reconcileKnowledge, reconcileConfiguredLessons: mocks.reconcileLessons,
}));
vi.mock('../learning/candidate-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/candidate-store.js')>(), CandidateStore: mocks.store,
}));
vi.mock('../learning/knowledge-publication-guard.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/knowledge-publication-guard.js')>(), assertCurrentKnowledgePublication: mocks.processGuard,
}));
vi.mock('../learning/lesson-publication-guard.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/lesson-publication-guard.js')>(), verifyLessonPublication: mocks.lessonGuard,
}));

const scope = 'github:acme/api';
const runId = 'retrospective-run-42';
const requestKey = 'a'.repeat(64);
const candidateId = 'b'.repeat(64);
const checkerId = 'approval-policy';
const input = { scope, runId, kind: 'process', checkerId };
const target = { scope, requestKey };
const configurationFile = '/private/retrospective/checkers.json';
const knowledge = { wikiScript: '/private/retrospective/wiki.sh', grants: ['/private/retrospective/grants.json'] };
const publication = { status: 'prepared', publication: { key: 'e'.repeat(64), phase: 'prepared' } };
const runtimes: PluginRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  expect(mocks.publish).not.toHaveBeenCalled();
});

function candidate(kind: 'process' | 'lesson' = 'process', state: LearningCandidate['state'] = 'candidate',
  id = candidateId, version = 7): LearningCandidate {
  const common = { title: 'Require approval', statement: 'Check approval before preparing knowledge.', evidenceIds: ['audit:42'],
    applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] } };
  const proposal: LearningCandidate['proposal'] = kind === 'process'
    ? { ...common, kind, payload: { entry: 'Completed run', systems: ['learning'], preconditions: [],
      steps: [{ id: 'approve', action: 'Check approval', stateChange: 'Validated', evidenceIds: ['audit:42'] }],
      exceptions: [], completion: 'Knowledge prepared' } }
    : { ...common, kind, payload: { trigger: 'Completed run', rootCause: 'Missing review', rootCauseStatus: 'confirmed',
      attempts: [], fix: 'Require review', prevention: ['Check approval'] } };
  return { id, requestKey, version, state, digest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64), proposal };
}

function requestState(overrides: Partial<LearningRequestState> = {}): LearningRequestState {
  const candidates = [candidate(), candidate('lesson', 'candidate', 'f'.repeat(64), 4)];
  return { job: { jobId: requestKey, scope, sourceId: `run:${runId}`, sourceRunId: runId, status: 'processed', attempts: [] },
    processing: { requestKey, outputDigest: '1'.repeat(64), candidateIds: candidates.map(entry => entry.id), warnings: [] },
    candidates, ...overrides };
}

function assetCandidate(kind: 'skill' | 'tool', state: LearningCandidate['state'] = 'candidate'): LearningCandidate {
  const selected = candidate('process', state);
  const common = { ...selected.proposal, kind };
  const cases = [
    { kind: 'normal' as const, input: 'valid', expected: 'success' },
    { kind: 'recovery' as const, input: 'retry', expected: 'success' },
    { kind: 'refusal' as const, input: 'invalid', expected: 'refused' },
  ];
  return { ...selected, proposal: kind === 'skill' ? { ...common, kind, payload: {
    newReason: 'No compatible skill exists', triggers: ['Review completed work'], prohibitedConditions: [], inputs: [],
    branches: [], recovery: ['Retry after checking the source'], completion: 'Reviewed', patch: 'Review the source.', evaluationCases: cases,
  } } : { ...common, kind, payload: {
    existingTools: [], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, dependencies: [], permissions: [],
    timeoutMs: 500, sideEffects: 'none', idempotency: 'Pure operation', recovery: 'Retry', source: 'return {}', tests: cases,
  } } };
}

function envelope(action: string, value: unknown) {
  return { iid: 42, worktreePath: '/tmp/learning-workflow', branch: 'feat/learning', targetBranch: 'main',
    step: { id: 'learning-action', kind: 'system', action, input: value }, input: value };
}

async function fixture(config: Partial<LearningConfiguration> = {}, withProvider = true) {
  const homeDir = mkdtempSync(join(realpathSync(tmpdir()), 'learning-retrospective-'));
  directories.push(homeDir);
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  const createExecution = vi.fn(async (): Promise<never> => { throw new Error('real_model_forbidden'); });
  const provider: AgentProvider = { name: 'claude-code', capabilities: new Set(['analysis']), createExecution };
  if (withProvider) await runtime.activate({
    manifest: { id: 'agent.retrospective-fixture', version: '0.1.0', apiVersion: 1, provides: ['agent.provider'], trusted: true },
    activate: context => context.registerAgentProvider('claude-code', provider),
  });
  await runtime.activate(createLearningPlugin({ homeDir, config: { enabled: true, knowledge,
    validation: { configurationFile }, ...config } }));
  const publishChange = vi.fn();
  const queueQA = vi.fn();
  const executor = new SystemActionExecutor({ plugins: runtime, publishChange, queueQA });
  const execute = (value: unknown = input, action = 'learning.retrospective') => executor.execute(action, envelope(action, value));
  return { runtime, executor, execute, homeDir, provider, createExecution, publishChange, queueQA };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockResolvedValue({ scanned: 1, submitted: 1, requestKeys: [requestKey], invalidated: 0,
    checkedSources: [{ runId, eventRoot: '/private/retrospective/events' }], blocked: [] });
  mocks.query.mockImplementation((selected: { scope: string; requestKey: string }) => {
    if (selected.scope !== scope || selected.requestKey !== requestKey) throw new Error('learning_request_not_found');
    return requestState();
  });
  mocks.queryAll.mockReturnValue({ jobs: [], candidates: [candidate('process', 'candidate', '9'.repeat(64))] });
  mocks.worker.mockImplementation(function () { return { runOnce: mocks.runOnce, close: mocks.closeWorker }; });
  mocks.runOnce.mockResolvedValue(requestState());
  mocks.closeWorker.mockResolvedValue(undefined);
  mocks.store.mockImplementation(function () { return { close: mocks.closeStore }; });
  mocks.validate.mockResolvedValue({ status: 'validated', candidateId, candidateVersion: 7, validatedVersion: 8 });
  mocks.prepare.mockResolvedValue(publication);
  mocks.reconcileKnowledge.mockResolvedValue({ results: [], blocked: [] });
  mocks.reconcileLessons.mockResolvedValue({ results: [], blocked: [] });
  mocks.lessonGuard.mockReturnValue({ status: 'current', binding: { checkerId, validatedVersion: 7 }, evidence: [] });
});

describe.each(['skill', 'tool'] as const)('learning.retrospective %s optimization validation with mocked execution boundaries', kind => {
  it.each(['direct', 'workflow'])('validates only exact-request assets without knowledge configuration through %s', async route => {
    const selected = assetCandidate(kind);
    const state = requestState({ candidates: [candidate('process', 'candidate', '9'.repeat(64)), selected] });
    mocks.query.mockReturnValue(state);
    const validation = { status: 'validated', candidateId, candidateVersion: 7, validatedVersion: 8,
      executionId: 'optimization-execution', receiptDigest: '2'.repeat(64) };
    mocks.validate.mockResolvedValue(validation);
    const { runtime, execute, homeDir, createExecution, publishChange } = await fixture({ knowledge: undefined });
    const result = route === 'direct' ? await runtime.dispatchSystemAction('learning.retrospective', { ...input, kind })
      : await execute({ ...input, kind });
    expect(result).toEqual({ scope, runId, requestKey, processing: state.processing, validated: [validation] });
    expect(mocks.validate.mock.calls).toEqual([[{ scope, candidateId, expectedVersion: 7, checkerId }, expect.objectContaining({
      file: join(homeDir, '.afk', 'learning', 'candidates.sqlite'), configurationFile, signal: expect.any(AbortSignal),
      proposal: { resolveRepository: expect.any(Function) },
    })]]);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.processGuard).not.toHaveBeenCalled();
    expect(mocks.lessonGuard).not.toHaveBeenCalled();
    expect(mocks.queryAll).not.toHaveBeenCalled();
    expect(createExecution).not.toHaveBeenCalled();
    expect(publishChange).not.toHaveBeenCalled();
  });

  it('processes the captured request once before validating the selected asset', async () => {
    const state = requestState({ candidates: [assetCandidate(kind)] });
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    mocks.runOnce.mockResolvedValue(state);
    const { execute } = await fixture({ knowledge: undefined });
    await expect(execute({ ...input, kind })).resolves.toHaveProperty('validated', [
      { status: 'validated', candidateId, candidateVersion: 7, validatedVersion: 8 },
    ]);
    expect(mocks.runOnce.mock.calls).toEqual([[target]]);
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(mocks.runOnce.mock.invocationCallOrder[0]).toBeLessThan(mocks.validate.mock.invocationCallOrder[0]!);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('preserves each independent validation receipt for multiple selected assets', async () => {
    const first = assetCandidate(kind);
    const second = { ...assetCandidate(kind), id: '3'.repeat(64), version: 12 };
    mocks.query.mockReturnValue(requestState({ candidates: [first, second] }));
    const receipts = [first, second].map((selected, index) => ({ status: 'validated', candidateId: selected.id,
      candidateVersion: selected.version, validatedVersion: selected.version + 1,
      executionId: `optimization-${index}`, receiptDigest: String(index + 2).repeat(64) }));
    mocks.validate.mockResolvedValueOnce(receipts[0]).mockResolvedValueOnce(receipts[1]);
    const { execute } = await fixture({ knowledge: undefined });
    await expect(execute({ ...input, kind })).resolves.toHaveProperty('validated', receipts);
    expect(mocks.validate.mock.calls.map(([request]) => request)).toEqual([first, second].map(selected => ({
      scope, candidateId: selected.id, expectedVersion: selected.version, checkerId,
    })));
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['unauthorized', 'insufficient_coverage', 'invalid_receipt'])('does not promote blocked validation: %s', async code => {
    mocks.query.mockReturnValue(requestState({ candidates: [assetCandidate(kind)] }));
    mocks.validate.mockResolvedValue({ status: 'blocked', code });
    const { execute } = await fixture({ knowledge: undefined });
    await expect(execute({ ...input, kind })).rejects.toThrow(`learning_validation_${code}`);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'throws'] as const)('returns committed receipts when the next validation %s and refuses stale replay', async failure => {
    const first = assetCandidate(kind);
    const second = { ...assetCandidate(kind), id: '3'.repeat(64) };
    const state = requestState({ candidates: [first, second] });
    mocks.query.mockReturnValue(state);
    const receipt = { status: 'validated' as const, candidateId: first.id, candidateVersion: first.version,
      validatedVersion: first.version + 1, executionId: 'optimization-first', receiptDigest: '2'.repeat(64) };
    mocks.validate.mockImplementationOnce(async () => {
      first.state = 'validated';
      first.version = receipt.validatedVersion;
      return receipt;
    });
    if (failure === 'blocked') mocks.validate.mockResolvedValueOnce({ status: 'blocked', code: 'unauthorized' });
    else mocks.validate.mockRejectedValueOnce(new Error('private-validator-detail'));
    const { execute } = await fixture({ knowledge: undefined });
    const error = await execute({ ...input, kind }).then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(LearningReviewIncompleteError);
    expect(error.output).toEqual({ status: 'incomplete', scope, runId, requestKey, validated: [receipt],
      interruptedCandidateId: second.id, reason: failure === 'blocked' ? 'validation_blocked' : 'validation_failed' });
    expect(JSON.stringify(error.output)).not.toContain('private-validator-detail');
    await expect(execute({ ...input, kind })).rejects.toThrow('learning_proposal_revalidation_required');
    expect(mocks.validate).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it.each(['direct', 'workflow'])('preserves a committed receipt when %s validation returns after cancellation', async route => {
    const first = assetCandidate(kind);
    const second = { ...assetCandidate(kind), id: '3'.repeat(64) };
    mocks.query.mockReturnValue(requestState({ candidates: [first, second] }));
    const receipt = { status: 'validated' as const, candidateId: first.id, candidateVersion: first.version,
      validatedVersion: first.version + 1, executionId: 'optimization-committed', receiptDigest: '2'.repeat(64) };
    const controller = new AbortController();
    mocks.validate.mockImplementationOnce(async (_request, options) => {
      expect(options.signal.aborted).toBe(false);
      controller.abort(new Error('private-cancellation-detail'));
      expect(options.signal.aborted).toBe(true);
      return receipt;
    });
    const { runtime, executor } = await fixture({ knowledge: undefined });
    const selected = { ...input, kind };
    const running = route === 'direct'
      ? runtime.dispatchSystemAction('learning.retrospective', selected, { signal: controller.signal })
      : executor.execute('learning.retrospective', envelope('learning.retrospective', selected), { signal: controller.signal });
    const error = await running.then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(LearningReviewIncompleteError);
    expect(error.output).toEqual({ status: 'incomplete', scope, runId, requestKey, validated: [receipt],
      interruptedCandidateId: first.id, reason: 'cancelled' });
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'throws'] as const)('preserves the first receipt when cancellation interrupts the next validation and it %s', async failure => {
    const first = assetCandidate(kind);
    const second = { ...assetCandidate(kind), id: '3'.repeat(64), version: 12 };
    const third = { ...assetCandidate(kind), id: '4'.repeat(64), version: 19 };
    mocks.query.mockReturnValue(requestState({ candidates: [first, second, third] }));
    const receipt = { status: 'validated' as const, candidateId: first.id, candidateVersion: first.version,
      validatedVersion: first.version + 1, executionId: 'optimization-before-cancellation', receiptDigest: '2'.repeat(64) };
    const controller = new AbortController();
    const reason = new Error('private-cancellation-detail');
    mocks.validate.mockImplementationOnce(async () => {
      first.state = 'validated';
      first.version = receipt.validatedVersion;
      return receipt;
    });
    mocks.validate.mockImplementationOnce(async (request, options) => {
      expect(request.candidateId).toBe(second.id);
      expect(first.state).toBe('validated');
      expect(options.signal.aborted).toBe(false);
      controller.abort(reason);
      expect(options.signal.aborted).toBe(true);
      expect(options.signal.reason).toBe(reason);
      if (failure === 'throws') throw new Error('private-validator-detail');
      return { status: 'blocked', code: 'cancelled' };
    });
    const { executor, publishChange } = await fixture({ knowledge: undefined });
    const selected = { ...input, kind };
    const error = await executor.execute('learning.retrospective', envelope('learning.retrospective', selected),
      { signal: controller.signal }).then(() => undefined, rejected => rejected);
    expect(error).toBeInstanceOf(LearningReviewIncompleteError);
    expect(error.output).toEqual({ status: 'incomplete', scope, runId, requestKey, validated: [receipt],
      interruptedCandidateId: second.id, reason: 'cancelled' });
    expect(JSON.stringify(error.output)).not.toMatch(/private-cancellation-detail|private-validator-detail/);
    expect(mocks.validate).toHaveBeenCalledTimes(2);
    expect(mocks.validate.mock.calls.map(([request]) => request)).toEqual([
      { scope, candidateId: first.id, expectedVersion: receipt.candidateVersion, checkerId },
      { scope, candidateId: second.id, expectedVersion: second.version, checkerId },
    ]);
    expect(mocks.queryAll).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.reconcileKnowledge).not.toHaveBeenCalled();
    expect(mocks.reconcileLessons).not.toHaveBeenCalled();
    expect(publishChange).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it.each(['validated', 'published', 'revoked', 'rejected'] as const)('rejects a prior %s asset before validating another candidate', async state => {
    const fresh = { ...assetCandidate(kind), id: '3'.repeat(64) };
    mocks.query.mockReturnValue(requestState({ candidates: [fresh, assetCandidate(kind, state)] }));
    const { execute } = await fixture({ knowledge: undefined });
    await expect(execute({ ...input, kind })).rejects.toThrow(state === 'validated'
      ? 'learning_proposal_revalidation_required' : 'learning_candidate_not_preparable');
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('requires saved validation authority before capturing a source', async () => {
    const { execute } = await fixture({ knowledge: undefined, validation: undefined });
    await expect(execute({ ...input, kind })).rejects.toThrow('validation_not_configured');
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it('rejects repair mode before capture', async () => {
    const { execute } = await fixture({ knowledge: undefined });
    await expect(execute({ ...input, kind, repair: true, workItemId: `${scope}#42` })).rejects.toThrow('repair_source_identity_required');
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
  });
});

describe('learning.retrospective production routing with mocked intake, worker/query, validation, store and publication I/O/guards', () => {
  it.each(['direct', 'workflow'])('binds an explicit canonical work item through %s routing', async route => {
    const workItemId = `${scope}#42`;
    const state = requestState();
    mocks.query.mockReturnValue({ ...state, job: { ...state.job, workItemId } });
    const { runtime, execute } = await fixture();
    const selected = { ...input, workItemId };
    const result = route === 'direct' ? await runtime.dispatchSystemAction('learning.retrospective', selected) : await execute(selected);
    expect(result).toHaveProperty('requestKey', requestKey);
    expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({ scope, runId, workItemId }));
  });

  it.each([undefined, `${scope}#43`])('rejects a stored receipt with work item %s before processing', async workItemId => {
    const state = requestState();
    mocks.query.mockReturnValue({ ...state, job: { ...state.job, workItemId } });
    const { execute } = await fixture();
    await expect(execute({ ...input, workItemId: `${scope}#42` })).rejects.toThrow('learning_source_mismatch');
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['42', ` ${scope}#42`, `${scope}#0`])('rejects noncanonical work item %j before capture', async workItemId => {
    const { execute } = await fixture();
    await expect(execute({ ...input, workItemId })).rejects.toThrow();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['source_work_item_mismatch', 'different-request'])('rejects a changed source during Worker recheck: %s', async change => {
    const workItemId = `${scope}#42`;
    const state = requestState();
    state.job.workItemId = workItemId;
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    mocks.runOnce.mockImplementation(async () => {
      mocks.capture.mockResolvedValue({ requestKeys: change === 'different-request' ? ['2'.repeat(64)] : [],
        checkedSources: [], blocked: change === 'different-request' ? [] : [{ runId, code: change }] });
      await mocks.worker.mock.calls[0]![0].reconcileSources();
      return state;
    });
    const { execute } = await fixture();
    await expect(execute({ ...input, workItemId })).rejects.toThrow('learning_capture_blocked');
    expect(mocks.capture).toHaveBeenLastCalledWith(expect.objectContaining({ scope, runId, workItemId }));
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['direct', 'workflow'])('prepares only the selected receipt kind through %s routing without publishing', async route => {
    const { runtime, execute, homeDir, createExecution, publishChange, queueQA } = await fixture();
    const result = route === 'direct' ? await runtime.dispatchSystemAction('learning.retrospective', input) : await execute();
    expect(result).toEqual({ scope, runId, requestKey, processing: requestState().processing,
      prepared: [{ candidateId, validatedVersion: 8, publication }] });
    expect(mocks.capture.mock.calls).toEqual([[{ directory: join(homeDir, '.afk', 'learning'), homeDir, scope, runId }]]);
    expect(mocks.query.mock.calls).toEqual([[{ directory: join(homeDir, '.afk', 'learning'), ...target }]]);
    expect(mocks.queryAll).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.validate.mock.calls).toEqual([[{ scope, candidateId, expectedVersion: 7, checkerId },
      expect.objectContaining({ file: join(homeDir, '.afk', 'learning', 'candidates.sqlite'), configurationFile,
        signal: expect.any(AbortSignal), resolveProvider: expect.any(Function), proposal: { resolveRepository: expect.any(Function) } })]]);
    expect(mocks.prepare.mock.calls).toEqual([[expect.objectContaining({ config: knowledge, scope, candidateId,
      expectedVersion: 8, validationConfigurationFile: configurationFile })]]);
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepare.mock.invocationCallOrder[0]!);
    expect(createExecution).not.toHaveBeenCalled();
    expect(publishChange).not.toHaveBeenCalled();
    expect(queueQA).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { ...input, scope: undefined }, { ...input, scope: 'not-a-project' }, { ...input, runId: undefined },
    { ...input, runId: '' }, { ...input, kind: undefined }, { ...input, kind: 'fact' }, { ...input, kind: 'unknown' },
    { ...input, checkerId: undefined }, { ...input, checkerId: '' }, { ...input, checkerId: 42 },
    ...[{ requestKey }, { candidateId }, { expectedVersion: 7 }, { eventRoot: '/private/forged' }, { enabled: true },
      { knowledge }, { validation: { configurationFile } }, { command: ['true'] }, { publish: true }].map(extra => ({ ...input, ...extra })),
  ])('rejects strict input case %# before capture or processing', async value => {
    const { execute } = await fixture();
    await expect(execute(value)).rejects.toMatchObject({ name: 'ZodError' });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { config: { enabled: false }, error: 'learning_disabled' },
    { config: { knowledge: undefined }, error: 'knowledge_not_configured' },
    { config: { validation: undefined }, error: 'validation_not_configured' },
  ])('rejects $error before capture', async ({ config, error }) => {
    const { execute } = await fixture(config);
    await expect(execute()).rejects.toThrow(error);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { requestKeys: [], blocked: [], error: 'learning_request_unavailable' },
    { requestKeys: [requestKey, '2'.repeat(64)], blocked: [], error: 'learning_request_ambiguous' },
    { requestKeys: [requestKey, requestKey], blocked: [], error: 'learning_request_ambiguous' },
    { requestKeys: [requestKey], blocked: [{ runId, code: 'audit_invalid' }], error: 'learning_capture_blocked' },
    { requestKeys: [], blocked: [{ runId, code: 'evidence_unavailable' }], error: 'learning_capture_blocked' },
  ])('throws $error instead of returning a blocked workflow result', async ({ requestKeys, blocked, error }) => {
    mocks.capture.mockResolvedValue({ scanned: 1, submitted: 0, requestKeys, checkedSources: [], invalidated: 0, blocked });
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow(error);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('propagates a capture failure without processing any request', async () => {
    const failure = new Error('capture_storage_unavailable');
    mocks.capture.mockRejectedValue(failure);
    const { execute } = await fixture();
    await expect(execute()).rejects.toBe(failure);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it.each(['other-run', undefined])('rejects a request bound to source run %s', async sourceRunId => {
    const state = requestState();
    mocks.query.mockReturnValue({ ...state, job: { ...state.job, sourceRunId } });
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow('learning_source_mismatch');
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([{ ...input, scope: 'github:other/api' }, { ...input }])('does not fall back to other request or scope data: %#', async selected => {
    if (selected.scope === scope) mocks.capture.mockResolvedValue({ scanned: 1, submitted: 0, requestKeys: ['2'.repeat(64)],
      checkedSources: [], invalidated: 0, blocked: [] });
    const { execute, homeDir } = await fixture();
    await expect(execute(selected)).rejects.toThrow('learning_request_not_found');
    expect(mocks.query.mock.calls).toEqual([[{ directory: join(homeDir, '.afk', 'learning'), scope: selected.scope,
      requestKey: selected.scope === scope ? '2'.repeat(64) : requestKey }]]);
    expect(mocks.queryAll).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('runs the worker for the exact unprocessed request and releases it once', async () => {
    const state = requestState();
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    const { execute, runtime, homeDir, provider, createExecution } = await fixture();
    await expect(execute()).resolves.toEqual({ scope, runId, requestKey, processing: state.processing,
      prepared: [{ candidateId, validatedVersion: 8, publication }] });
    expect(mocks.worker.mock.calls).toEqual([[expect.objectContaining({ directory: join(homeDir, '.afk', 'learning'),
      provider, reconcileSources: expect.any(Function) })]]);
    expect(mocks.runOnce.mock.calls).toEqual([[target]]);
    await mocks.worker.mock.calls[0]![0].reconcileSources();
    expect(mocks.capture).toHaveBeenLastCalledWith({ directory: join(homeDir, '.afk', 'learning'), homeDir, scope, runId });
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(createExecution).not.toHaveBeenCalled();
  });

  it('reuses processing without resolving an analysis provider', async () => {
    const { runtime, execute } = await fixture({}, false);
    const getProvider = vi.spyOn(runtime, 'getProvider');
    await expect(execute()).resolves.toHaveProperty('processing', requestState().processing);
    expect(getProvider).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.runOnce).not.toHaveBeenCalled();
    getProvider.mockRestore();
  });

  it('rejects an unprocessed request when no analysis provider is available', async () => {
    const state = requestState();
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    const { execute } = await fixture({}, false);
    await expect(execute()).rejects.toThrow('analysis_unsupported');
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('propagates worker failure and releases its owned worker', async () => {
    const state = requestState();
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    const failure = new Error('worker_failed');
    mocks.runOnce.mockRejectedValue(failure);
    const { execute, runtime } = await fixture();
    await expect(execute()).rejects.toBe(failure);
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['pending', 'blocked', 'failed'] as const)('throws when targeted processing leaves the job %s', async status => {
    const state = requestState();
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    mocks.runOnce.mockResolvedValue({ job: { ...state.job, status }, candidates: [] });
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow('learning_request_blocked');
    expect(mocks.runOnce.mock.calls).toEqual([[target]]);
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['pending', 'blocked', 'failed', 'reason'] as const)('rejects inconsistent existing processing: %s', async problem => {
    const state = requestState();
    mocks.query.mockReturnValue({ ...state, job: { ...state.job,
      ...(problem === 'reason' ? { reasonCode: 'evidence_unavailable' } : { status: problem }) } });
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow('learning_request_blocked');
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([{ candidates: [] }, { candidates: [candidate('lesson')] }])('rejects zero selected-kind candidates in this receipt: %#', async ({ candidates }) => {
    mocks.query.mockReturnValue(requestState({ candidates }));
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow('learning_candidates_unavailable');
    expect(mocks.queryAll).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('selects lesson members and passes their actual candidate and validated versions', async () => {
    const lessonId = 'f'.repeat(64);
    mocks.validate.mockResolvedValue({ status: 'validated', candidateId: lessonId, candidateVersion: 4, validatedVersion: 5 });
    const { execute } = await fixture();
    await expect(execute({ ...input, kind: 'lesson' })).resolves.toHaveProperty('prepared', [{ candidateId: lessonId, validatedVersion: 5, publication }]);
    expect(mocks.validate.mock.calls).toEqual([[{ scope, candidateId: lessonId, expectedVersion: 4, checkerId }, expect.any(Object)]]);
    expect(mocks.prepare.mock.calls).toEqual([[expect.objectContaining({ candidateId: lessonId, expectedVersion: 5 })]]);
  });

  it('prepares every selected member using its own version, leaving the other kind untouched', async () => {
    const second = candidate('process', 'candidate', '3'.repeat(64), 12);
    const state = requestState();
    state.candidates.push(second);
    state.processing!.candidateIds.push(second.id);
    mocks.query.mockReturnValue(state);
    mocks.validate.mockImplementation(async (selected: { expectedVersion: number }) => ({ status: 'validated', validatedVersion: selected.expectedVersion + 1 }));
    const { execute } = await fixture();
    await expect(execute()).resolves.toHaveProperty('prepared', [
      { candidateId, validatedVersion: 8, publication }, { candidateId: second.id, validatedVersion: 13, publication },
    ]);
    expect(mocks.validate.mock.calls.map(([selected]) => selected)).toEqual([
      { scope, candidateId, expectedVersion: 7, checkerId }, { scope, candidateId: second.id, expectedVersion: 12, checkerId },
    ]);
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });

  it.each(['checker_unavailable', 'version_conflict', 'authorization_denied'])('throws on blocked validation %s without preparation', async code => {
    mocks.validate.mockResolvedValue({ status: 'blocked', code });
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow(`learning_validation_${code}`);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('propagates an unexpected validation exception', async () => {
    const failure = new Error('validation_io_failed');
    mocks.validate.mockRejectedValue(failure);
    const { execute } = await fixture();
    await expect(execute()).rejects.toBe(failure);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('propagates prepare failure instead of reporting workflow success', async () => {
    const failure = new Error('knowledge_target_unavailable_or_ambiguous');
    mocks.prepare.mockRejectedValue(failure);
    const { execute } = await fixture();
    await expect(execute()).rejects.toBe(failure);
    expect(mocks.validate).toHaveBeenCalledTimes(1);
  });

  it.each(['conflict', 'published', 'rejected', 'superseded', 'revoked'] as const)('rejects a %s candidate without validation or preparation', async state => {
    mocks.query.mockReturnValue(requestState({ candidates: [candidate('process', state)] }));
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow('learning_candidate_not_preparable');
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['process', 'lesson'] as const)('replays a validated %s only after its current publication guard', async kind => {
    const selected = candidate(kind, 'validated');
    mocks.query.mockReturnValue(requestState({ candidates: [selected] }));
    const { execute, homeDir } = await fixture({}, false);
    await expect(execute({ ...input, kind })).resolves.toHaveProperty('prepared', [{ candidateId, validatedVersion: 7, publication }]);
    const guard = kind === 'process' ? mocks.processGuard : mocks.lessonGuard;
    expect(mocks.store.mock.calls).toEqual([[{ file: join(homeDir, '.afk', 'learning', 'candidates.sqlite') }]]);
    expect(guard.mock.calls).toEqual([[{ store: mocks.store.mock.results[0]!.value, candidate: selected, configurationFile, homeDir,
      ...(kind === 'process' ? { checkerId } : {}) }, { signal: expect.any(AbortSignal) }]]);
    expect(guard.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepare.mock.invocationCallOrder[0]!);
    expect(mocks.closeStore).toHaveBeenCalledTimes(1);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.prepare.mock.calls).toEqual([[expect.objectContaining({ scope, candidateId, expectedVersion: 7 })]]);
  });

  it.each(['authorization_changed', 'checker_unavailable', 'invalid_receipt'])('propagates the validated process guard rejection: %s', async code => {
    mocks.query.mockReturnValue(requestState({ candidates: [candidate('process', 'validated')] }));
    const failure = new Error(`knowledge_publication_${code}`);
    mocks.processGuard.mockImplementation(() => { throw failure; });
    const { execute } = await fixture();
    await expect(execute()).rejects.toBe(failure);
    expect(mocks.processGuard).toHaveBeenCalledWith(expect.objectContaining({ checkerId, configurationFile }), expect.any(Object));
    expect(mocks.closeStore).toHaveBeenCalledTimes(1);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'blocked', code: 'authorization_changed' }, { status: 'blocked', code: 'configuration_unavailable' },
    { status: 'blocked', code: 'invalid_receipt' }, { status: 'current', binding: { checkerId: 'other-checker', validatedVersion: 7 }, evidence: [] },
  ])('rejects stale or differently checked lesson replay: %#', async guardResult => {
    mocks.query.mockReturnValue(requestState({ candidates: [candidate('lesson', 'validated')] }));
    mocks.lessonGuard.mockReturnValue(guardResult);
    const { execute } = await fixture();
    await expect(execute({ ...input, kind: 'lesson' })).rejects.toThrow('learning_validation_unavailable');
    expect(mocks.closeStore).toHaveBeenCalledTimes(1);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('disposes an active owned worker and stops before validation after plugin closure', async () => {
    const state = requestState();
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    let finishWorker!: (value: LearningRequestState) => void;
    let workerStarted!: () => void;
    const started = new Promise<void>(resolve => { workerStarted = resolve; });
    mocks.runOnce.mockImplementation(() => {
      workerStarted();
      return new Promise<LearningRequestState>(resolve => { finishWorker = resolve; });
    });
    const { execute, runtime } = await fixture();
    const running = execute();
    const rejected = expect(running).rejects.toThrow('learning_plugin_closed');
    await started;
    await runtime.close();
    expect(mocks.closeWorker).toHaveBeenCalled();
    finishWorker(state);
    await rejected;
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe('review regressions: prepare-only recovery, operation cancellation and source-less exact requests', () => {
  function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>(complete => { resolve = complete; });
    return { promise, resolve };
  }

  it.each(['first', 'replay', 'worker-recheck'])('never invokes publication recovery during retrospective %s', async path => {
    mocks.reconcileKnowledge.mockImplementation(async () => {
      await mocks.publish();
      return { results: [], blocked: [] };
    });
    const state = requestState();
    if (path === 'worker-recheck') {
      mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
      mocks.runOnce.mockImplementation(async (selected: typeof target) => {
        await mocks.worker.mock.calls[0]![0].reconcileSources(selected);
        return state;
      });
    }
    const { execute } = await fixture();
    await expect(execute()).resolves.toHaveProperty('prepared', [{ candidateId, validatedVersion: 8, publication }]);
    if (path === 'replay') {
      mocks.query.mockReturnValue(requestState({ candidates: [candidate('process', 'validated', candidateId, 8)] }));
      await expect(execute()).resolves.toHaveProperty('prepared', [{ candidateId, validatedVersion: 8, publication }]);
    }
    expect(mocks.capture).toHaveBeenCalledTimes(path === 'first' ? 1 : 2);
    if (path === 'worker-recheck') {
      expect(mocks.runOnce.mock.calls).toEqual([[target]]);
      expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    }
    expect(mocks.reconcileKnowledge).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each(['direct', 'workflow'])('rejects an already cancelled %s operation without disabling the plugin', async route => {
    const controller = new AbortController();
    const reason = new Error('review_operation_cancelled');
    controller.abort(reason);
    const { runtime, executor, execute } = await fixture();
    const running = route === 'direct'
      ? runtime.dispatchSystemAction('learning.retrospective', input, { signal: controller.signal })
      : executor.execute('learning.retrospective', envelope('learning.retrospective', input), { signal: controller.signal });
    await expect(running).rejects.toBe(reason);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    await expect(execute()).resolves.toHaveProperty('prepared', [{ candidateId, validatedVersion: 8, publication }]);
  });

  it.each([
    { stage: 'capture', route: 'direct' }, { stage: 'capture', route: 'workflow' },
    { stage: 'worker', route: 'direct' }, { stage: 'worker', route: 'workflow' },
    { stage: 'validation', route: 'direct' }, { stage: 'validation', route: 'workflow' },
  ])('stops a $route operation cancelled while awaiting $stage and keeps the plugin usable', async ({ stage, route }) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const state = requestState();
    const captured = { scanned: 1, submitted: 1, requestKeys: [requestKey], invalidated: 0, checkedSources: [], blocked: [] };
    const validated = { status: 'validated', candidateId, candidateVersion: 7, validatedVersion: 8 };
    if (stage === 'capture') mocks.capture.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return captured;
    });
    if (stage === 'worker') {
      mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
      mocks.runOnce.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return state;
      });
    }
    if (stage === 'validation') mocks.validate.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return validated;
    });
    const controller = new AbortController();
    const reason = new Error('review_operation_cancelled');
    const { runtime, executor, execute } = await fixture();
    const running = route === 'direct'
      ? runtime.dispatchSystemAction('learning.retrospective', input, { signal: controller.signal })
      : executor.execute('learning.retrospective', envelope('learning.retrospective', input), { signal: controller.signal });
    const outcome = running.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));
    await entered.promise;
    controller.abort(reason);
    await Promise.resolve();
    const closedWhileWaiting = mocks.closeWorker.mock.calls.length;
    release.resolve();
    const result = await outcome;
    const prepareCallsAfterCancellation = mocks.prepare.mock.calls.length;
    const closedAfterCancellation = mocks.closeWorker.mock.calls.length;
    mocks.query.mockReturnValue(state);
    await expect(runtime.dispatchSystemAction('learning.settings', {})).resolves.toHaveProperty('enabled', true);
    await expect(execute()).resolves.toHaveProperty('prepared', [{ candidateId, validatedVersion: 8, publication }]);
    expect.soft(result).toMatchObject({ status: 'rejected', error: reason });
    expect.soft(prepareCallsAfterCancellation).toBe(0);
    if (stage === 'capture') {
      expect(mocks.worker).not.toHaveBeenCalled();
      expect(mocks.validate).toHaveBeenCalledTimes(1);
    }
    if (stage === 'worker') {
      expect.soft(closedWhileWaiting).toBeGreaterThan(0);
      expect(closedAfterCancellation).toBeGreaterThan(0);
      expect(mocks.runOnce.mock.calls).toEqual([[target]]);
      expect(mocks.validate).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['correction', 'import'])('processes an exact %s request without sourceRunId or global recovery', async kind => {
    const state = requestState();
    state.job = { ...state.job, sourceId: kind === 'correction' ? `candidate:${candidateId}` : 'import:approved-notes', sourceRunId: undefined };
    mocks.query.mockReturnValue({ job: { ...state.job, status: 'pending' }, candidates: [] });
    mocks.runOnce.mockImplementation(async (selected: typeof target) => {
      await mocks.worker.mock.calls[0]![0].reconcileSources(selected);
      return state;
    });
    const { execute, runtime } = await fixture();
    await expect(execute(target, 'learning.worker.once')).resolves.toEqual(state);
    expect(mocks.runOnce.mock.calls).toEqual([[target]]);
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining(target));
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.reconcileKnowledge).not.toHaveBeenCalled();
    expect(mocks.reconcileLessons).not.toHaveBeenCalled();
    expect(mocks.queryAll).not.toHaveBeenCalled();
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
  });
});

describe('related learning actions through the same real runtime and workflow executor', () => {
  it.each([{}, target])('forwards worker.once input %# without broadening an exact target', async value => {
    const { execute, runtime } = await fixture();
    await execute(value, 'learning.worker.once');
    expect(mocks.runOnce.mock.calls).toEqual('requestKey' in value ? [[target]] : [[]]);
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
  });

  it.each([{ scope }, { requestKey }, { ...target, runId }, { ...target, requestKey: 'bad' }])('rejects partial or non-strict worker target %#', async value => {
    const { execute } = await fixture();
    await expect(execute(value, 'learning.worker.once')).rejects.toMatchObject({ name: 'ZodError' });
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it('routes learning.request with exact scope/key through direct and workflow inputs', async () => {
    const { runtime, execute, homeDir } = await fixture();
    await expect(runtime.dispatchSystemAction('learning.request', target)).resolves.toEqual(requestState());
    await expect(execute(target, 'learning.request')).resolves.toEqual(requestState());
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenNthCalledWith(1, { directory: join(homeDir, '.afk', 'learning'), ...target });
    expect(mocks.query).toHaveBeenNthCalledWith(2, { directory: join(homeDir, '.afk', 'learning'), ...target });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it.each([{ scope }, { requestKey }, { ...target, runId }, { ...target, scope: 'not-a-project' }])('rejects non-strict learning.request input %#', async value => {
    const { execute } = await fixture();
    await expect(execute(value, 'learning.request')).rejects.toMatchObject({ name: 'ZodError' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
