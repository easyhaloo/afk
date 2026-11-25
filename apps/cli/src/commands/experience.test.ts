import { Command } from 'commander';
import { existsSync, mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkItemId } from '@afk/runtime/domain/work-item/identity';
import { LearningReviewIncompleteError } from '@afk/runtime/execution';
import type { ExperienceAdoptionContext, ExperienceStore, LearningCandidate, LearningJob, LearningState, LearningValidationResult } from '@afk/runtime/execution';
import { registerExperienceCommands, type ExperienceCommandComposition } from './experience.js';

const runtime = vi.hoisted(() => ({
  ExperienceStore: vi.fn(),
  experienceStorePath: vi.fn(() => '/tmp/afk-experience-command-test.sqlite'),
  experienceScope: vi.fn(),
  verifyExperienceRun: vi.fn(),
  verifyAdoptionRun: vi.fn(),
  learningDirectory: vi.fn(() => '/tmp/afk-learning-command-test'),
  queryLearningState: vi.fn(),
  createCliPluginRuntime: vi.fn(),
  runSuccessReviewWorkflow: vi.fn(),
  runRepairReviewWorkflow: vi.fn(),
  runOptimizationReviewWorkflow: vi.fn(),
}));
vi.mock('@afk/runtime/execution', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/runtime/execution')>(), ...runtime,
}));
vi.mock('../composition-root.js', () => ({ createCliPluginRuntime: runtime.createCliPluginRuntime }));
vi.mock('@afk/runtime/application/workflows/run-cmd', () => ({ runSuccessReviewWorkflow: runtime.runSuccessReviewWorkflow,
  runRepairReviewWorkflow: runtime.runRepairReviewWorkflow, runOptimizationReviewWorkflow: runtime.runOptimizationReviewWorkflow }));

const scope = 'gitlab:git.example.test/team/project';
const workItemId = `${scope}#42`;
const directories: string[] = [];
const candidate = {
  id: 'experience-42', scope, status: 'candidate', trigger: 'test failed', rootCause: 'missing input validation',
  action: 'validate input before writing', source: { runId: 'failed-run', workItemId }, evidence: ['evidence://failed-run/test'],
};

beforeEach(() => {
  runtime.experienceScope.mockImplementation((id: string) => {
    const parsed = parseWorkItemId(id);
    return `${parsed.platform}:${parsed.projectKey}`;
  });
  runtime.verifyExperienceRun.mockImplementation(async (input: { runId: string; evidence: string[] }) => [...input.evidence, `run:${input.runId}#qa.passed`]);
  runtime.verifyAdoptionRun.mockResolvedValue({ actual: {} } satisfies ExperienceAdoptionContext);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const records = [structuredClone(candidate)];
  const store = {
    recordFailure: vi.fn((input: Omit<typeof candidate, 'id' | 'status'>) => {
      const record = { ...input, id: 'recorded-experience', status: 'candidate' };
      records.push(record);
      return record;
    }),
    list: vi.fn((options: { scope: string; status?: string; limit?: number }) => records
      .filter(record => record.scope === options.scope && (!options.status || record.status === options.status))
      .slice(0, options.limit)),
    get: vi.fn((id: string, scope: string) => records.find(record => record.id === id && record.scope === scope)),
    recall: vi.fn(() => [{ ...candidate, status: 'verified' }]),
    verify: vi.fn((id: string, input: { evidence: string[]; runId: string; action?: string }) => {
      const record = records.find(record => record.id === id)!;
      Object.assign(record, { ...input, status: 'verified' });
      return record;
    }),
    revoke: vi.fn((id: string) => {
      const record = records.find(record => record.id === id)!;
      record.status = 'revoked';
      return record;
    }),
    export: vi.fn(() => JSON.stringify({ version: 1, scope, experiences: [] })),
    import: vi.fn(() => [candidate]),
    copy: vi.fn(() => ({ ...candidate, scope: 'github:acme/target' })),
    metrics: vi.fn(() => ({ retrievals: 3, adoptions: 1, recurrences: 2 })),
    outcomeReceipts: vi.fn<Parameters<ExperienceStore['outcomeReceipts']>, ReturnType<ExperienceStore['outcomeReceipts']>>(() => []),
    adopt: vi.fn<Parameters<ExperienceStore['adopt']>, ReturnType<ExperienceStore['adopt']>>(() => ({ retrievals: 3, adoptions: 2, recurrences: 2, receipt: { binding: 'verified-version',
      experienceId: candidate.id, scope, source: { runId: 'using-run', workItemId }, version: 1,
      verificationDigest: 'a'.repeat(64), contextDigest: 'b'.repeat(64), contextStatus: 'unavailable', acknowledgedAt: '2026-11-16T10:00:00.000Z' } })),
    close: vi.fn(),
  };
  runtime.ExperienceStore.mockImplementation(() => store);
  const createStore = vi.fn(() => store);
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  const program = new Command().name('afk').exitOverride().configureOutput({ writeErr: () => {} });
  registerExperienceCommands(program, { createStore: createStore as unknown as ExperienceCommandComposition['createStore'], verifyRun: runtime.verifyExperienceRun });
  return { store, records, createStore, program, output,
    parse: (...args: string[]) => program.parseAsync(['node', 'afk', 'experience', ...args]),
    printed: () => output.join(''),
  };
}

function cliJobs(jobs: LearningJob[]) {
  return jobs.map(({ canRun, ...job }) => job);
}

function learningFixture(composition: ExperienceCommandComposition = {}) {
  const job: LearningJob = { jobId: 'a'.repeat(64), scope, sourceId: 'run:42', sourceRunId: 'source-run', workItemId,
    status: 'blocked', canRun: true, reasonCode: 'budget_exhausted', attempts: [] };
  const proposal: LearningCandidate = { id: 'b'.repeat(64), requestKey: job.jobId, version: 1, state: 'candidate',
    digest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64), proposal: {
      kind: 'fact', title: 'Input validation', statement: 'Validate before writing', evidenceIds: ['audit-1'],
      applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
      payload: { subject: 'input', rule: 'Validate', classification: 'proposal' },
    } };
  const state: LearningState = { jobs: [job], candidates: [proposal] };
  const query = vi.fn(() => state);
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  const program = new Command().name('afk').exitOverride().configureOutput({ writeErr: () => {} });
  registerExperienceCommands(program, { queryLearningState: query, ...composition });
  return { state, job, proposal, query, program, output,
    parse: (...args: string[]) => program.parseAsync(['node', 'afk', 'experience', ...args]),
    printed: () => output.join(''),
  };
}

describe('execution review', () => {
  const reviewOutput = { scope, runId: 'source-run', requestKey: 'a'.repeat(64),
    processing: { requestKey: 'a'.repeat(64), outputDigest: 'd'.repeat(64), candidateIds: ['b'.repeat(64)], warnings: [] },
    prepared: [{ candidateId: 'b'.repeat(64), validatedVersion: 2,
      publication: { key: 'c'.repeat(64), phase: 'prepared', candidateId: 'b'.repeat(64), expectedVersion: 2 } }] };
  const repairOutput = { ...reviewOutput, runId: 'failed-run' };
  const validation = { status: 'validated', candidateId: 'b'.repeat(64), candidateVersion: 1, validatedVersion: 2,
    executionId: 'validation-run', receiptDigest: 'c'.repeat(64) } satisfies LearningValidationResult;
  const optimizationOutput = { scope, runId: 'source-run', requestKey: reviewOutput.requestKey,
    processing: reviewOutput.processing, validated: [validation] };
  const incompleteOutput = { status: 'incomplete' as const, scope, runId: 'source-run', requestKey: reviewOutput.requestKey,
    validated: [validation], interruptedCandidateId: 'e'.repeat(64), reason: 'validation_failed' as const };
  const reviewResult = (output: object = reviewOutput) => ({ success: true, steps: { review: { stepId: 'review', status: 'completed',
    startedAt: '2026-11-18T00:00:00.000Z', completedAt: '2026-11-18T00:00:01.000Z', output } } });
  const pluginsFixture = () => ({ dispatchSystemAction: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) });
  const reviewFixture = (composition: ExperienceCommandComposition = {}) => {
    const test = learningFixture(composition);
    return { ...test, review: (...args: string[]) => test.parse('review', '--backlog-id', workItemId,
      '--run-id', 'source-run', '--checker', 'process-policy-v1', ...args) };
  };

  beforeEach(() => {
    runtime.runSuccessReviewWorkflow.mockResolvedValue(reviewResult());
    runtime.runRepairReviewWorkflow.mockResolvedValue(reviewResult(repairOutput));
    runtime.runOptimizationReviewWorkflow.mockResolvedValue(reviewResult(optimizationOutput));
  });

  describe.each(['success', 'repair', 'skill', 'tool'] as const)('%s review scope boundaries', kind => {
    const scopes = [
      { encoding: 'ASCII', scope: `github:acme/${'a'.repeat(500)}` },
      { encoding: 'UTF-8', scope: `github:acme/${'界'.repeat(166)}aa` },
    ];

    it.each(scopes.flatMap(boundary => ['owned', 'injected'].map(source => ({ ...boundary, source }))))(
      'rejects a 513-byte $encoding scope before the $source runtime factory or workflow dispatch', async ({ scope, source }) => {
        const plugins = pluginsFixture();
        const createRuntime = vi.fn().mockResolvedValue(plugins);
        runtime.createCliPluginRuntime.mockResolvedValue(plugins);
        const test = reviewFixture(source === 'injected' ? { createRuntime } : {});
        const invalidScope = `${scope}a`;
        const workItemId = `${invalidScope}#42`;
        expect(Buffer.byteLength(invalidScope, 'utf8')).toBe(513);
        expect(parseWorkItemId(workItemId).id).toBe(workItemId);
        const error = await test.review('--kind', kind, '--backlog-id', workItemId).catch(error => error);
        expect(error.message).toBe('Learning review failed');
        expect(error.cause).toBeUndefined();
        expect(createRuntime).not.toHaveBeenCalled();
        expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
        expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
        expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
        expect(runtime.runOptimizationReviewWorkflow).not.toHaveBeenCalled();
        expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
        expect(plugins.dispose).not.toHaveBeenCalled();
        expect(test.printed()).toBe('');
      });

    it.each(scopes)('accepts and preserves a canonical 512-byte $encoding scope', async ({ scope }) => {
      const plugins = pluginsFixture();
      runtime.createCliPluginRuntime.mockResolvedValue(plugins);
      const runner = kind === 'success' ? runtime.runSuccessReviewWorkflow : kind === 'repair'
        ? runtime.runRepairReviewWorkflow : runtime.runOptimizationReviewWorkflow;
      const output = { ...(kind === 'success' ? reviewOutput : kind === 'repair' ? repairOutput : optimizationOutput), scope };
      runner.mockResolvedValue(reviewResult(output));
      const test = reviewFixture();
      const workItemId = `${scope}#42`;
      expect(Buffer.byteLength(scope, 'utf8')).toBe(512);
      expect(parseWorkItemId(workItemId).id).toBe(workItemId);
      await test.review('--kind', kind, '--backlog-id', workItemId, '--json');
      expect(runtime.createCliPluginRuntime).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledWith({ plugins, backlogId: workItemId, sourceRunId: 'source-run',
        checkerId: 'process-policy-v1', ...(kind === 'skill' || kind === 'tool' ? { kind } : {}) });
      for (const other of [runtime.runSuccessReviewWorkflow, runtime.runRepairReviewWorkflow, runtime.runOptimizationReviewWorkflow]) {
        if (other !== runner) expect(other).not.toHaveBeenCalled();
      }
      expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
      expect(plugins.dispose).toHaveBeenCalledOnce();
      expect(test.printed()).toBe(`${JSON.stringify(output)}\n`);
    });
  });

  it.each([false, true])('selects only the success workflow with an explicit success kind=%s', async explicit => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = reviewFixture();
    await test.review(...(explicit ? ['--kind', 'success'] : []));
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledOnce();
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledWith({ plugins, backlogId: workItemId,
      sourceRunId: 'source-run', checkerId: 'process-policy-v1' });
    expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.runOptimizationReviewWorkflow).not.toHaveBeenCalled();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe(`${JSON.stringify(reviewOutput, null, 2)}\n`);
  });

  it('forwards canonical repair identities and options to the injected repair workflow without selecting success', async () => {
    const plugins = pluginsFixture();
    const runRepairReviewWorkflow = vi.fn().mockResolvedValue(reviewResult(repairOutput));
    const runSuccessReviewWorkflow = vi.fn();
    const test = reviewFixture({ pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'],
      runRepairReviewWorkflow, runSuccessReviewWorkflow });
    await test.review('--kind', 'repair', '--backlog-id', workItemId, '--run-id', ' failed-run ',
      '--checker', ' lesson-policy-v1 ', '--session', ' repair-session ', '--hard-timeout', '2147483647');
    expect(runRepairReviewWorkflow).toHaveBeenCalledOnce();
    expect(runRepairReviewWorkflow).toHaveBeenCalledWith({ plugins, backlogId: workItemId,
      sourceRunId: 'failed-run', checkerId: 'lesson-policy-v1', session: 'repair-session', hardTimeoutMs: 2147483647 });
    expect(runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(test.printed()).toBe(`${JSON.stringify(repairOutput, null, 2)}\n`);
  });

  it.each([false, true])('prints only the repair preview after closing its owned runtime with compact JSON=%s', async compact => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    runtime.runRepairReviewWorkflow.mockResolvedValue({ ...reviewResult(repairOutput), url: 'INTERNAL_REPAIR_METADATA' });
    const test = reviewFixture();
    plugins.dispose.mockImplementation(async () => {
      expect(runtime.runRepairReviewWorkflow).toHaveBeenCalledOnce();
      expect(test.printed()).toBe('');
    });
    await test.review('--kind', 'repair', '--run-id', 'failed-run', '--checker', 'lesson-policy-v1', ...(compact ? ['--json'] : []));
    expect(runtime.createCliPluginRuntime).toHaveBeenCalledOnce();
    expect(runtime.runRepairReviewWorkflow).toHaveBeenCalledOnce();
    expect(runtime.runRepairReviewWorkflow).toHaveBeenCalledWith({ plugins, backlogId: workItemId,
      sourceRunId: 'failed-run', checkerId: 'lesson-policy-v1' });
    expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(test.printed()).toBe(`${JSON.stringify(repairOutput, null, compact ? undefined : 2)}\n`);
    expect(JSON.parse(test.printed())).toEqual(repairOutput);
    expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
    expect(plugins.dispose).toHaveBeenCalledOnce();
  });

  it.each(['workflow', 'dispose'] as const)('closes the owned repair runtime and prints no preview when %s fails', async failure => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    if (failure === 'workflow') runtime.runRepairReviewWorkflow.mockRejectedValueOnce(new Error('PRIVATE_REPAIR_TOKEN'));
    else plugins.dispose.mockRejectedValueOnce(new Error('PRIVATE_REPAIR_TOKEN'));
    const test = reviewFixture();
    const error = await test.review('--kind', 'repair', '--json').catch(error => error);
    expect(error.message).toBe('Learning review failed');
    expect(error.cause).toBeUndefined();
    expect(runtime.runRepairReviewWorkflow).toHaveBeenCalledOnce();
    expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each(['skill', 'tool'].flatMap(kind => ['github:acme/api#42',
    `gitlab:git.example.test/${'engineering/'.repeat(12)}project#42`].map(backlogId => ({ kind, backlogId }))))(
    'forwards $kind validation identities and options to the injected workflow for $backlogId', async ({ kind, backlogId }) => {
      const plugins = pluginsFixture();
      const identity = parseWorkItemId(backlogId);
      const output = { ...optimizationOutput, scope: `${identity.platform}:${identity.projectKey}` };
      const runOptimizationReviewWorkflow = vi.fn().mockResolvedValue(reviewResult(output));
      const test = reviewFixture({ pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'], runOptimizationReviewWorkflow });
      await test.review('--kind', kind, '--backlog-id', backlogId, '--run-id', ' source-run ', '--checker', ' optimization-policy-v1 ',
        '--session', ' optimization-session ', '--hard-timeout', '2147483647');
      expect(runOptimizationReviewWorkflow).toHaveBeenCalledOnce();
      expect(runOptimizationReviewWorkflow).toHaveBeenCalledWith({ kind, plugins, backlogId, sourceRunId: 'source-run',
        checkerId: 'optimization-policy-v1', session: 'optimization-session', hardTimeoutMs: 2147483647 });
      expect(runtime.runOptimizationReviewWorkflow).not.toHaveBeenCalled();
      expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
      expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
      expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
      expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
      expect(plugins.dispose).not.toHaveBeenCalled();
      expect(test.printed()).toBe(`${JSON.stringify(output, null, 2)}\n`);
    });

  it.each(['skill', 'tool'].flatMap(kind => [false, true].map(compact => ({ kind, compact }))))(
    'prints only $kind validation receipts after disposing its owned runtime with compact JSON=$compact', async ({ kind, compact }) => {
      const plugins = pluginsFixture();
      runtime.createCliPluginRuntime.mockResolvedValue(plugins);
      runtime.runOptimizationReviewWorkflow.mockResolvedValue({ ...reviewResult(optimizationOutput), url: 'INTERNAL_OPTIMIZATION_METADATA' });
      const test = reviewFixture();
      plugins.dispose.mockImplementation(async () => {
        expect(runtime.runOptimizationReviewWorkflow).toHaveBeenCalledOnce();
        expect(test.printed()).toBe('');
      });
      await test.review('--kind', kind, ...(compact ? ['--json'] : []));
      expect(runtime.runOptimizationReviewWorkflow).toHaveBeenCalledOnce();
      expect(runtime.runOptimizationReviewWorkflow).toHaveBeenCalledWith({ kind, plugins, backlogId: workItemId,
        sourceRunId: 'source-run', checkerId: 'process-policy-v1' });
      expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
      expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
      expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
      expect(plugins.dispose).toHaveBeenCalledOnce();
      expect(test.printed()).toBe(`${JSON.stringify(optimizationOutput, null, compact ? undefined : 2)}\n`);
      expect(JSON.parse(test.printed())).toEqual(optimizationOutput);
    });

  it.each(['skill', 'tool'].flatMap(kind => ['startup', 'workflow', 'result', 'dispose'].map(failure => ({ kind, failure }))))(
    'sanitizes $kind validation $failure failures and disposes its owned runtime without output', async ({ kind, failure }) => {
      const plugins = pluginsFixture();
      const privateError = new Error('PRIVATE_OPTIMIZATION_TOKEN');
      runtime.createCliPluginRuntime.mockResolvedValue(plugins);
      if (failure === 'startup') runtime.createCliPluginRuntime.mockRejectedValueOnce(privateError);
      if (failure === 'workflow') runtime.runOptimizationReviewWorkflow.mockRejectedValueOnce(privateError);
      if (failure === 'result') runtime.runOptimizationReviewWorkflow.mockResolvedValueOnce({ success: false });
      if (failure === 'dispose') plugins.dispose.mockRejectedValueOnce(privateError);
      const test = reviewFixture();
      const error = await test.review('--kind', kind, '--json').catch(error => error);
      expect(error.message).toBe('Learning review failed');
      expect(error.cause).toBeUndefined();
      expect(runtime.runOptimizationReviewWorkflow).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
      expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
      expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
      expect(plugins.dispose).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
      expect(test.printed()).toBe('');
    });

  it.each(['failure', 'REPAIR', ' repair ', 'SKILL', 'tool ', 'process', ''])('rejects the invalid review kind %j before opening a runtime', async kind => {
    const createRuntime = vi.fn();
    const test = reviewFixture({ createRuntime });
    await expect(test.review('--kind', kind)).rejects.toMatchObject({ code: 'commander.invalidArgument', exitCode: 1 });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.runOptimizationReviewWorkflow).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each(['2147483648', '9007199254740991', '9007199254740992'])(
    'rejects repair hard-timeout overflow %s before opening a runtime', async timeout => {
      const createRuntime = vi.fn();
      const test = reviewFixture({ createRuntime });
      await expect(test.review('--kind', 'repair', '--hard-timeout', timeout)).rejects.toThrow(/^Learning review failed$/);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
      expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
      expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
      expect(test.printed()).toBe('');
    });

  it('accepts the maximum hard timeout of 2147483647 milliseconds', async () => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = reviewFixture();
    await test.review('--hard-timeout', '2147483647');
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledOnce();
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledWith({ plugins, backlogId: workItemId,
      sourceRunId: 'source-run', checkerId: 'process-policy-v1', hardTimeoutMs: 2147483647 });
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(test.printed())).toEqual(reviewOutput);
  });

  it('maps canonical identity and all explicit options to the injected workflow runner', async () => {
    const plugins = pluginsFixture();
    const runSuccessReviewWorkflow = vi.fn().mockResolvedValue(reviewResult());
    const test = reviewFixture({ pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'], runSuccessReviewWorkflow });
    await test.review('--run-id', ' source-run ', '--checker', ' process-policy-v1 ', '--session', ' learning-session ', '--hard-timeout', '120000');
    expect(runSuccessReviewWorkflow).toHaveBeenCalledOnce();
    expect(runSuccessReviewWorkflow).toHaveBeenCalledWith({ plugins, backlogId: workItemId,
      sourceRunId: 'source-run', checkerId: 'process-policy-v1', session: 'learning-session', hardTimeoutMs: 120000 });
    expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(test.printed()).toBe(`${JSON.stringify(reviewOutput, null, 2)}\n`);
  });

  it.each([false, true])('prints only the exact review DTO with compact JSON=%s', async compact => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    runtime.runSuccessReviewWorkflow.mockResolvedValue({ ...reviewResult(), url: 'INTERNAL_WORKFLOW_METADATA' });
    const test = reviewFixture();
    await test.review(...(compact ? ['--json'] : []));
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledOnce();
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledWith({ plugins, backlogId: workItemId,
      sourceRunId: 'source-run', checkerId: 'process-policy-v1' });
    expect(test.printed()).toBe(`${JSON.stringify(reviewOutput, null, compact ? undefined : 2)}\n`);
    expect(JSON.parse(test.printed())).toEqual(reviewOutput);
    expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
    expect(plugins.dispose).toHaveBeenCalledOnce();
  });

  it('opens its owned runtime lazily and waits for the workflow before disposal and output', async () => {
    let finish!: (result: ReturnType<typeof reviewResult>) => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    runtime.runSuccessReviewWorkflow.mockImplementationOnce(() => {
      started();
      return new Promise<ReturnType<typeof reviewResult>>(resolve => { finish = resolve; });
    });
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = reviewFixture();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    const pending = test.review();
    await running;
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
    finish(reviewResult());
    await pending;
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(test.printed())).toEqual(reviewOutput);
  });

  it.each([
    ['--run-id', 'sourceRunId'], ['--checker', 'checkerId'],
  ])('accepts a trimmed 512-character %s identity', async (option, field) => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = reviewFixture();
    const identity = 'a'.repeat(512);
    await test.review(option, ` ${identity} `);
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledOnce();
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledWith(expect.objectContaining({ [field]: identity }));
    expect(plugins.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { success: false, steps: { review: { output: { credential: 'PRIVATE_TOKEN' } } } },
    { success: true }, { success: true, steps: {} }, { success: true, steps: { review: {} } },
    ...[null, 'PRIVATE_TOKEN', []].map(output => ({ success: true, steps: { review: { output } } })),
  ])('rejects unsuccessful or missing structured review results without printing output: %j', async result => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    runtime.runSuccessReviewWorkflow.mockResolvedValue(result);
    const test = reviewFixture();
    const error = await test.review('--json').catch(error => error);
    expect(error.message).toBe('Learning review failed');
    expect(error.cause).toBeUndefined();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each([
    ['--backlog-id', '42'], ['--backlog-id', scope], ['--backlog-id', `${scope}#0`],
    ['--backlog-id', ` ${workItemId}`], ['--backlog-id', 'unknown:team/project#42'],
    ['--backlog-id', 'github:acme/api#9007199254740992'],
    ['--run-id', ' '], ['--run-id', 'source\0run'], ['--checker', ' '], ['--checker', 'checker\0id'],
    ...['--run-id', '--checker'].flatMap(option => ['identity\nvalue', 'identity\rvalue', 'identity\tvalue', 'a'.repeat(513)]
      .map(value => [option, value])),
    ['--session', ' '], ['--session', 'session\0name'],
    ...['0', '-1', '1.5', '1e3', 'Infinity', '2147483648', '9007199254740991', '9007199254740992'].map(value => ['--hard-timeout', value]),
  ].flatMap(([option, value]) => ['success', 'repair', 'skill', 'tool'].map(kind => ({ kind, option, value }))))(
    'validates $kind $option $value before opening a runtime', async ({ kind, option, value }) => {
    const createRuntime = vi.fn();
    const test = reviewFixture({ createRuntime });
    await expect(test.review('--kind', kind, option, value)).rejects.toThrow(/^Learning review failed$/);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.runRepairReviewWorkflow).not.toHaveBeenCalled();
    expect(runtime.runOptimizationReviewWorkflow).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each(['--backlog-id', '--run-id', '--checker'])('requires %s before opening a runtime', async missing => {
    const test = reviewFixture();
    const options = [['--backlog-id', workItemId], ['--run-id', 'source-run'], ['--checker', 'process-policy-v1']];
    await expect(test.parse('review', ...options.filter(([option]) => option !== missing).flat())).rejects.toThrow();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(runtime.runSuccessReviewWorkflow).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  const incompleteCases = (['skill', 'tool'] as const).flatMap(kind => (['validation_blocked', 'validation_failed', 'cancelled'] as const)
    .flatMap(reason => [false, true].map(json => ({ kind, reason, json }))));
  it.each(incompleteCases)(
    'prints only safe partial $kind receipts for $reason after disposal (json=$json) and rejects', async ({ kind, reason, json }) => {
      const output = { ...incompleteOutput, reason };
      const privateError = new Error('PRIVATE_PROVIDER credential=PRIVATE_TOKEN');
      const incomplete = new LearningReviewIncompleteError(output, { cause: privateError });
      incomplete.message = 'PRIVATE_PROVIDER credential=PRIVATE_TOKEN';
      const runOptimizationReviewWorkflow = vi.fn().mockRejectedValue(incomplete);
      const plugins = pluginsFixture();
      runtime.createCliPluginRuntime.mockResolvedValue(plugins);
      const test = reviewFixture({ runOptimizationReviewWorkflow });
      plugins.dispose.mockImplementationOnce(async () => { expect(test.printed()).toBe(''); });
      const error = await test.review('--kind', kind, ...(json ? ['--json'] : [])).catch(error => error);
      expect(error.message).toBe('Learning review failed');
      expect(error.cause).toBeUndefined();
      expect(test.printed()).toBe(`${JSON.stringify(output, null, json ? undefined : 2)}\n`);
      expect(test.printed()).not.toContain('PRIVATE_');
      expect(runOptimizationReviewWorkflow).toHaveBeenCalledOnce();
      expect(runOptimizationReviewWorkflow).toHaveBeenCalledWith({ plugins, backlogId: workItemId,
        sourceRunId: 'source-run', checkerId: 'process-policy-v1', kind });
      expect(runtime.runOptimizationReviewWorkflow).not.toHaveBeenCalled();
      expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
      expect(plugins.dispose).toHaveBeenCalledOnce();
    });

  it('waits for owned runtime disposal before printing partial receipts or rejecting', async () => {
    let finish!: () => void;
    let started!: () => void;
    const disposing = new Promise<void>(resolve => { started = resolve; });
    const plugins = pluginsFixture();
    plugins.dispose.mockImplementationOnce(() => {
      started();
      return new Promise<void>(resolve => { finish = resolve; });
    });
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const runOptimizationReviewWorkflow = vi.fn().mockRejectedValue(new LearningReviewIncompleteError(incompleteOutput));
    const test = reviewFixture({ runOptimizationReviewWorkflow });
    let settled = false;
    const pending = test.review('--kind', 'skill', '--json').catch(error => { settled = true; return error; });
    await disposing;
    expect(settled).toBe(false);
    expect(test.printed()).toBe('');
    finish();
    const error = await pending;
    expect(error.message).toBe('Learning review failed');
    expect(error.cause).toBeUndefined();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe(`${JSON.stringify(incompleteOutput)}\n`);
  });

  it.each(['skill', 'tool'] as const)('preserves safe %s receipts and rejection when owned runtime disposal fails', async kind => {
    const plugins = pluginsFixture();
    plugins.dispose.mockRejectedValueOnce(new Error('PRIVATE_DISPOSAL credential=PRIVATE_TOKEN'));
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const runOptimizationReviewWorkflow = vi.fn().mockRejectedValue(new LearningReviewIncompleteError(incompleteOutput,
      { cause: new Error('PRIVATE_PROVIDER credential=PRIVATE_TOKEN') }));
    const test = reviewFixture({ runOptimizationReviewWorkflow });
    const error = await test.review('--kind', kind, '--json').catch(error => error);
    expect(error.message).toBe('Learning review failed');
    expect(error.cause).toBeUndefined();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe(`${JSON.stringify(incompleteOutput)}\n`);
    expect(test.printed()).not.toContain('PRIVATE_');
  });

  it.each((['skill', 'tool'] as const).flatMap(kind => ['injected', 'factory'].map(source => ({ kind, source }))))(
    'preserves borrowed $source runtime ownership while printing incomplete $kind receipts', async ({ kind, source }) => {
      const plugins = pluginsFixture();
      const createRuntime = vi.fn().mockResolvedValue(plugins);
      const runOptimizationReviewWorkflow = vi.fn().mockRejectedValue(new LearningReviewIncompleteError(incompleteOutput));
      const test = reviewFixture({ runOptimizationReviewWorkflow, ...(source === 'injected'
        ? { pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'] } : { createRuntime }) });
      const error = await test.review('--kind', kind, '--json').catch(error => error);
      expect(error.message).toBe('Learning review failed');
      expect(error.cause).toBeUndefined();
      expect(runOptimizationReviewWorkflow).toHaveBeenCalledOnce();
      expect(createRuntime).toHaveBeenCalledTimes(source === 'factory' ? 1 : 0);
      expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
      expect(plugins.dispose).not.toHaveBeenCalled();
      expect(test.printed()).toBe(`${JSON.stringify(incompleteOutput)}\n`);
    });

  it.each([
    { label: 'missing DTO', output: undefined },
    { label: 'null DTO', output: null },
    { label: 'wrong status', output: { ...incompleteOutput, status: 'success' } },
    { label: 'missing identity', output: { ...incompleteOutput, runId: undefined } },
    { label: 'invalid request key', output: { ...incompleteOutput, requestKey: 'PRIVATE_TOKEN' } },
    { label: 'no receipts', output: { ...incompleteOutput, validated: [] } },
    { label: 'unvalidated receipt', output: { ...incompleteOutput, validated: [{ ...validation, status: 'blocked' }] } },
    { label: 'invalid receipt', output: { ...incompleteOutput, validated: [{ ...validation, receiptDigest: 'PRIVATE_TOKEN' }] } },
    { label: 'unsupported reason', output: { ...incompleteOutput, reason: 'PRIVATE_PROVIDER' } },
    { label: 'extra provider detail', output: { ...incompleteOutput, credential: 'PRIVATE_TOKEN' } },
    { label: 'extra receipt detail', output: { ...incompleteOutput, validated: [{ ...validation, credential: 'PRIVATE_TOKEN' }] } },
  ])('rejects an incomplete error with $label without printing its payload', async ({ output }) => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const incomplete = new LearningReviewIncompleteError(incompleteOutput, { cause: new Error('PRIVATE_PROVIDER') });
    Object.defineProperty(incomplete, 'output', { value: output });
    const runOptimizationReviewWorkflow = vi.fn().mockRejectedValue(incomplete);
    const test = reviewFixture({ runOptimizationReviewWorkflow });
    const error = await test.review('--kind', 'tool', '--json').catch(error => error);
    expect(error.message).toBe('Learning review failed');
    expect(error.cause).toBeUndefined();
    expect(runOptimizationReviewWorkflow).toHaveBeenCalledOnce();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each((['skill', 'tool'] as const).flatMap(kind => [
    { label: 'scope', output: { ...incompleteOutput, scope: 'github:acme/other' } },
    { label: 'source run', output: { ...incompleteOutput, runId: 'different-source-run' } },
  ].map(mismatch => ({ kind, ...mismatch }))))(
    'rejects valid incomplete $kind receipts from a different $label without printing them', async ({ kind, output }) => {
      const plugins = pluginsFixture();
      runtime.createCliPluginRuntime.mockResolvedValue(plugins);
      const runOptimizationReviewWorkflow = vi.fn().mockRejectedValue(new LearningReviewIncompleteError(output));
      const test = reviewFixture({ runOptimizationReviewWorkflow });
      const error = await test.review('--kind', kind, '--json').catch(error => error);
      expect(error.message).toBe('Learning review failed');
      expect(error.cause).toBeUndefined();
      expect(runOptimizationReviewWorkflow).toHaveBeenCalledOnce();
      expect(plugins.dispose).toHaveBeenCalledOnce();
      expect(test.printed()).toBe('');
    });

  it('rejects a generic provider error with an incomplete-looking payload without printing it', async () => {
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const error = Object.assign(new Error('PRIVATE_PROVIDER credential=PRIVATE_TOKEN'),
      { name: 'LearningReviewIncompleteError', output: incompleteOutput });
    const runOptimizationReviewWorkflow = vi.fn().mockRejectedValue(error);
    const test = reviewFixture({ runOptimizationReviewWorkflow });
    const failure = await test.review('--kind', 'skill', '--json').catch(error => error);
    expect(failure.message).toBe('Learning review failed');
    expect(failure.cause).toBeUndefined();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each(['startup', 'workflow', 'dispose'] as const)('sanitizes %s errors and releases only an owned runtime', async failure => {
    const privateError = new Error('PRIVATE_PROVIDER credential=PRIVATE_TOKEN');
    const plugins = pluginsFixture();
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    if (failure === 'startup') runtime.createCliPluginRuntime.mockRejectedValueOnce(privateError);
    if (failure === 'workflow') runtime.runSuccessReviewWorkflow.mockRejectedValueOnce(privateError);
    if (failure === 'dispose') plugins.dispose.mockRejectedValueOnce(privateError);
    const test = reviewFixture();
    const error = await test.review('--json').catch(error => error);
    expect(error.message).toBe('Learning review failed');
    expect(error.cause).toBeUndefined();
    expect(plugins.dispose).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
    expect(runtime.runSuccessReviewWorkflow).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
    expect(test.printed()).toBe('');
  });

  it.each(['success', 'skill', 'tool'].flatMap(kind => ['injected', 'factory'].map(source => ({ kind, source }))))(
    'preserves borrowed $source runtime ownership on $kind success and workflow rejection', async ({ kind, source }) => {
    const plugins = pluginsFixture();
    const createRuntime = vi.fn().mockResolvedValue(plugins);
    const test = reviewFixture(source === 'injected'
      ? { pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'] } : { createRuntime });
    await test.review('--kind', kind);
    test.output.length = 0;
    const review = kind === 'success' ? runtime.runSuccessReviewWorkflow : runtime.runOptimizationReviewWorkflow;
    review.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER credential=PRIVATE_TOKEN'));
    await expect(test.review('--kind', kind)).rejects.toThrow(/^Learning review failed$/);
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(source === 'factory' ? 2 : 0);
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(plugins.dispatchSystemAction).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });
});

describe('candidate correction', () => {
  const receipt = { jobId: 'a'.repeat(64), scope, candidateId: 'b'.repeat(64), candidateVersion: 1 };
  function correctionFixture(composition: ExperienceCommandComposition = {}, content: string | Buffer = 'Correct the candidate\n') {
    const root = mkdtempSync(join(tmpdir(), 'learning-correction-cli-'));
    directories.push(root);
    const file = join(root, 'correction.txt');
    writeFileSync(file, content);
    const test = learningFixture(composition);
    return { ...test, root, file, correct: (...args: string[]) => test.parse('correct', test.proposal.id,
      '--scope', scope, '--expected-version', '1', '--file', file, ...args) };
  }

  it.each([false, true])('queues the exact bounded UTF-8 text and prints only the receipt (json=%s)', async json => {
    const correction = ` \n${'纠'.repeat(10921)}!\n `;
    expect(Buffer.byteLength(correction, 'utf8')).toBe(32768);
    const dispatchSystemAction = vi.fn().mockResolvedValue({ ...receipt, correction, providerError: 'PRIVATE_PROVIDER' });
    const test = correctionFixture({ pluginRuntime: { dispatchSystemAction } as unknown as ExperienceCommandComposition['pluginRuntime'] }, correction);
    const original = structuredClone(test.proposal);
    await test.correct(...(json ? ['--json'] : []));
    expect(dispatchSystemAction).toHaveBeenCalledOnce();
    expect(dispatchSystemAction).toHaveBeenCalledWith('learning.correct', { scope, candidateId: test.proposal.id, expectedVersion: 1, correction });
    expect(test.printed()).toBe(`${JSON.stringify(receipt, null, json ? undefined : 2)}\n`);
    expect(test.proposal).toEqual(original);
    expect(test.query).not.toHaveBeenCalled();
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''], ['whitespace', ' \t\r\n\u3000'], ['NUL', 'PRIVATE_CONTENT\0secret'],
    ['invalid UTF-8', Buffer.from([0xff])], ['truncated UTF-8', Buffer.from([0xe4, 0xb8])],
    ['overlong UTF-8', Buffer.from([0xc0, 0xaf])], ['oversized ASCII', 'x'.repeat(32769)],
    ['oversized UTF-8', '纠'.repeat(10923)],
  ])('rejects %s correction before creating or dispatching a runtime', async (_label, content) => {
    const createRuntime = vi.fn();
    const test = correctionFixture({ createRuntime }, content);
    await expect(test.correct()).rejects.toThrow(/^Learning correction failed$/);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each(['missing', 'directory', 'device'])('rejects a %s file without exposing its path or opening a runtime', async kind => {
    const createRuntime = vi.fn();
    const test = correctionFixture({ createRuntime });
    const file = kind === 'missing' ? join(test.root, 'PRIVATE_PATH') : kind === 'directory' ? test.root : '/dev/null';
    const error = await test.correct('--file', file).catch(error => error);
    expect(error.message).toBe('Learning correction failed');
    expect(error.cause).toBeUndefined();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it('bounds reads and closes the file when its size grows after stat', async () => {
    const createRuntime = vi.fn();
    const test = correctionFixture({ createRuntime }, 'x'.repeat(32769));
    const handle = await fs.open(test.file, 'r');
    vi.spyOn(handle, 'stat').mockResolvedValue({ isFile: () => true, size: 0 } as Awaited<ReturnType<typeof handle.stat>>);
    const close = vi.spyOn(handle, 'close');
    const read = vi.spyOn(handle, 'read');
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    await expect(test.correct()).rejects.toThrow(/^Learning correction failed$/);
    expect(read.mock.calls[0]?.[0]).toHaveLength(32769);
    expect(close).toHaveBeenCalledOnce();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each([
    ['--expected-version', '0'], ['--expected-version', '-1'], ['--expected-version', '1.5'],
    ['--expected-version', '9007199254740992'], ['--expected-version', '1e0'], ['--expected-version', 'Infinity'],
    ['--scope', 'project'], ['--scope', ` ${scope}`], ['--scope', `${scope}#42`], ['--scope', 'unknown:team/project'],
  ])('rejects invalid %s %s before reading a file or creating a runtime', async (option, value) => {
    const createRuntime = vi.fn();
    const test = correctionFixture({ createRuntime });
    const open = vi.spyOn(fs, 'open');
    await expect(test.correct(option, value)).rejects.toThrow(/^Learning correction failed$/);
    expect(open).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each(['invalid', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(64)}\n`])('rejects malformed candidate ID %j before reading a file', async candidateId => {
    const createRuntime = vi.fn();
    const test = correctionFixture({ createRuntime });
    const open = vi.spyOn(fs, 'open');
    await expect(test.parse('correct', candidateId, '--scope', scope, '--expected-version', '1', '--file', test.file))
      .rejects.toThrow(/^Learning correction failed$/);
    expect(open).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it('requires a file and rejects inline correction text', async () => {
    const createRuntime = vi.fn();
    const test = correctionFixture({ createRuntime });
    await expect(test.parse('correct', test.proposal.id, '--scope', scope, '--expected-version', '1')).rejects.toThrow();
    await expect(test.correct('--correction', 'PRIVATE_CONTENT')).rejects.toThrow();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each(['injected', 'factory'] as const)('never disposes a borrowed %s runtime on success or rejection', async source => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue(receipt), dispose: vi.fn() };
    const createRuntime = vi.fn().mockResolvedValue(plugins);
    const test = correctionFixture(source === 'injected'
      ? { pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'] } : { createRuntime });
    await test.correct();
    test.output.length = 0;
    plugins.dispatchSystemAction.mockRejectedValue(new Error('PRIVATE_PROVIDER credential=PRIVATE_TOKEN'));
    await expect(test.correct()).rejects.toThrow(/^Learning correction failed$/);
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(source === 'factory' ? 2 : 0);
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each([
    { reason: 'stale version', args: ['--expected-version', '2'], scope, expectedVersion: 2 },
    { reason: 'foreign project', args: ['--scope', 'github:private/project'], scope: 'github:private/project', expectedVersion: 1 },
  ])('preserves the runtime guard for $reason without retrying or falling back', async current => {
    const plugins = { dispatchSystemAction: vi.fn().mockRejectedValue(new Error(`${current.reason}: PRIVATE_CONTENT`)), dispose: vi.fn() };
    const test = correctionFixture({ pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'] });
    await expect(test.correct(...current.args)).rejects.toThrow(/^Learning correction failed$/);
    expect(plugins.dispatchSystemAction).toHaveBeenCalledOnce();
    expect(plugins.dispatchSystemAction).toHaveBeenCalledWith('learning.correct', { scope: current.scope,
      candidateId: test.proposal.id, expectedVersion: current.expectedVersion, correction: 'Correct the candidate\n' });
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(test.proposal.version).toBe(1);
    expect(test.printed()).toBe('');
  });

  it('lazily creates the default runtime and disposes it only after dispatch completes', async () => {
    let finish!: (result: typeof receipt) => void;
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const plugins = { dispatchSystemAction: vi.fn(() => {
      started();
      return new Promise<typeof receipt>(resolve => { finish = resolve; });
    }), dispose: vi.fn().mockResolvedValue(undefined) };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = correctionFixture();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    const pending = test.correct();
    await dispatched;
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
    finish(receipt);
    await pending;
    expect(runtime.createCliPluginRuntime).toHaveBeenCalledOnce();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(test.printed())).toEqual(receipt);
  });

  it.each(['startup', 'dispatch', 'dispose'] as const)('sanitizes %s failure and disposes only an owned runtime', async failure => {
    const privateError = new Error('PRIVATE_CONTENT provider credential=PRIVATE_TOKEN');
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue(receipt), dispose: vi.fn().mockResolvedValue(undefined) };
    if (failure === 'dispatch') plugins.dispatchSystemAction.mockRejectedValue(privateError);
    if (failure === 'dispose') plugins.dispose.mockRejectedValue(privateError);
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    if (failure === 'startup') runtime.createCliPluginRuntime.mockRejectedValue(privateError);
    const test = correctionFixture();
    const error = await test.correct('--json').catch(error => error);
    expect(error.message).toBe('Learning correction failed');
    expect(error.cause).toBeUndefined();
    expect(plugins.dispose).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
    expect(test.printed()).toBe('');
  });

  it.each([
    { jobId: 'PRIVATE_PROVIDER' }, { jobId: 'A'.repeat(64) }, { scope: 'github:private/project' },
    { candidateId: 'c'.repeat(64) }, { candidateVersion: 0 }, { candidateVersion: 2 }, { candidateVersion: 1.5 },
    { candidateVersion: Number.MAX_SAFE_INTEGER + 1 }, { candidateVersion: '1' },
  ])('rejects malformed or foreign receipts without leaking provider data: %j', async invalid => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ ...receipt, ...invalid }), dispose: vi.fn().mockResolvedValue(undefined) };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = correctionFixture();
    await expect(test.correct('--json')).rejects.toThrow(/^Learning correction failed$/);
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });
});

describe('learning worker once', () => {
  const requestKey = 'a'.repeat(64);
  const args = ['worker', 'once', '--scope', scope, '--request', requestKey, '--json'];

  it.each(['processed', 'blocked'] as const)('returns a bounded summary of the exact %s job', async status => {
    const exitCode = process.exitCode;
    const job = { jobId: requestKey, scope, status, canRun: status === 'blocked',
      reasonCode: status === 'blocked' ? 'budget_exhausted' : 'PRIVATE_REASON' };
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({
      job: { ...job, attempts: [{ sessionId: 'PRIVATE_SESSION' }], sourceId: 'PRIVATE_SOURCE' },
      processing: { warnings: ['PRIVATE_WARNING'] }, candidates: [{ proposal: 'PRIVATE_PROPOSAL' }],
    }), dispose: vi.fn() };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = learningFixture();
    try {
      await test.parse(...args);
      expect(plugins.dispatchSystemAction).toHaveBeenCalledOnce();
      expect(plugins.dispatchSystemAction).toHaveBeenCalledWith('learning.worker.once', { scope, requestKey }, { signal: expect.any(AbortSignal) });
      expect(plugins.dispose).toHaveBeenCalledOnce();
      expect(test.query).not.toHaveBeenCalled();
      expect(test.printed()).toBe(`${JSON.stringify({ job: { jobId: requestKey, scope, status, canRun: job.canRun,
        attemptCount: 1, ...(status === 'blocked' ? { reasonCode: job.reasonCode } : {}) } })}\n`);
      expect(process.exitCode).toBe(status === 'processed' ? exitCode : 1);
    } finally { process.exitCode = exitCode; }
  });

  it.each([
    ['Trigger queue is already owned by a live or unverifiable listener', 'learning_worker_busy'],
    ['learning_disabled', 'learning_disabled'],
    ['PRIVATE_TRANSCRIPT and PRIVATE_PATH', 'learning_worker_failed'],
  ])('maps worker error %s to %s', async (message, code) => {
    const plugins = { dispatchSystemAction: vi.fn().mockRejectedValue(new Error(message)), dispose: vi.fn() };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = learningFixture();
    await expect(test.parse(...args)).rejects.toThrow(new Error(code));
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('cancels work on %s and removes its listeners', async signalName => {
    const signals = ['SIGINT', 'SIGTERM'] as const;
    const listeners = signals.map(name => process.listeners(name));
    const plugins = { dispatchSystemAction: vi.fn(async (_name, _target, { signal }: { signal: AbortSignal }) => {
      const added = process.listeners(signalName).find(listener => !listeners[signals.indexOf(signalName)].includes(listener));
      expect(added).toBeDefined();
      Reflect.apply(added!, process, []);
      expect(signal.aborted).toBe(true);
      return { job: { jobId: requestKey, scope, status: 'processed', canRun: false, attempts: [] } };
    }), dispose: vi.fn() };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = learningFixture();
    await expect(test.parse(...args)).rejects.toThrow('learning_worker_cancelled');
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(signals.map(name => process.listeners(name))).toEqual(listeners);
    expect(test.printed()).toBe('');
  });

  it.each([['--scope', 'noncanonical'], ['--request', 'A'.repeat(64)]])('rejects invalid %s before activation', async (flag, value) => {
    const test = learningFixture();
    await expect(test.parse(...args.map((part, index) => args[index - 1] === flag ? value : part)))
      .rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
  });

  it('rejects a result for a different request from a borrowed runtime', async () => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ job: { jobId: 'b'.repeat(64), scope,
      status: 'processed', canRun: false, attempts: [] } }), dispose: vi.fn() };
    const test = learningFixture({ pluginRuntime: plugins as unknown as ExperienceCommandComposition['pluginRuntime'] });
    await expect(test.parse(...args)).rejects.toThrow('learning_worker_failed');
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });
});

describe('learning worker watch', () => {
  it('stops on SIGTERM, disposes its runtime and writes only the shutdown receipt', async () => {
    const existing = process.listeners('SIGTERM');
    const plugins = { dispatchSystemAction: vi.fn(async (_action, _input, { signal }: { signal: AbortSignal }) => {
      const stop = process.listeners('SIGTERM').find(listener => !existing.includes(listener));
      expect(stop).toBeDefined();
      Reflect.apply(stop!, process, []);
      expect(signal.aborted).toBe(true);
      return { status: 'stopped', internal: '/private/ledger' };
    }), dispose: vi.fn() };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = learningFixture();
    await test.parse('worker', 'watch', '--json');
    expect(plugins.dispatchSystemAction).toHaveBeenCalledOnce();
    expect(plugins.dispatchSystemAction).toHaveBeenCalledWith('learning.worker.watch', {}, { signal: expect.any(AbortSignal) });
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(process.listeners('SIGTERM')).toEqual(existing);
    expect(test.printed()).toBe('{"status":"stopped"}\n');
  });

  it('reports unexpected listener termination and cleans up the runtime', async () => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ status: 'stopped' }), dispose: vi.fn() };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = learningFixture();
    await expect(test.parse('worker', 'watch', '--json')).rejects.toThrow('learning_worker_failed');
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });
});

describe('read-only learning governance', () => {
  it.each([
    { command: ['prepare', 'b'.repeat(64), '--expected-version', '2', '--target', 'wiki:retry'],
      action: 'prepare', input: { scope, candidateId: 'b'.repeat(64), expectedVersion: 2, targetRef: 'wiki:retry' },
      result: { key: 'e'.repeat(64), phase: 'prepared' } },
    { command: ['publish', 'e'.repeat(64)], action: 'publish', input: { scope, key: 'e'.repeat(64) },
      result: { publication: { key: 'e'.repeat(64), phase: 'committed' } } },
    { command: ['reconcile'], action: 'reconcile', input: { scope }, result: { results: [], blocked: [] } },
  ])('dispatches scoped knowledge $action without legacy storage or disposing borrowed runtimes', async current => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue(current.result), dispose: vi.fn() };
    const test = learningFixture({ pluginRuntime: plugins as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
    await test.parse('knowledge', ...current.command, '--scope', scope, '--json');
    expect(plugins.dispatchSystemAction).toHaveBeenCalledOnce();
    expect(plugins.dispatchSystemAction).toHaveBeenCalledWith(`learning.knowledge.${current.action}`, current.input);
    expect(JSON.parse(test.printed())).toEqual(current.result);
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['dispatch', 'dispose', 'startup'] as const)('sanitizes knowledge %s failures and releases its owned runtime', async failure => {
    const error = new Error('PRIVATE_TRANSCRIPT credential=PRIVATE_TOKEN');
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ results: [], blocked: [] }), dispose: vi.fn().mockResolvedValue(undefined) };
    if (failure === 'dispatch') plugins.dispatchSystemAction.mockRejectedValue(error);
    if (failure === 'dispose') plugins.dispose.mockRejectedValue(error);
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    if (failure === 'startup') runtime.createCliPluginRuntime.mockRejectedValue(error);
    const test = learningFixture();
    await expect(test.parse('knowledge', 'reconcile', '--scope', scope)).rejects.toThrow(/^Learning knowledge operation failed$/);
    expect(plugins.dispose).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
    expect(test.printed()).not.toContain('PRIVATE_');
  });

  it.each([
    ['prepare', 'invalid', '--expected-version', '2', '--scope', scope],
    ['prepare', 'b'.repeat(64), '--expected-version', '0', '--scope', scope],
    ['publish', 'e'.repeat(64), '--scope', 'other-project'],
  ])('rejects invalid knowledge input before creating a runtime: %s', async (...args) => {
    const test = learningFixture();
    await expect(test.parse('knowledge', ...args)).rejects.toThrow();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { command: ['publish', 'e'.repeat(64)], result: { publication: { phase: 'conflict' }, withdrawal: { status: 'withdrawn' } }, code: 1 },
    { command: ['reconcile'], result: { results: [], blocked: [{ key: 'e'.repeat(64), code: 'publication_recovery_blocked' }] }, code: 1 },
    { command: ['reconcile'], result: { results: [{ publication: { phase: 'conflict' }, withdrawal: { status: 'rollback_blocked' } }], blocked: [] }, code: 1 },
    { command: ['reconcile'], result: { results: [{ publication: { phase: 'conflict' }, withdrawal: { status: 'withdrawn' } }], blocked: [] }, code: 0 },
  ])('reports actual knowledge outcome with exit status $code', async current => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const dispatchSystemAction = vi.fn().mockResolvedValue(current.result);
      const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
      await test.parse('knowledge', ...current.command, '--scope', scope, '--json');
      expect(JSON.parse(test.printed())).toEqual(current.result);
      expect(process.exitCode).toBe(current.code);
    } finally { process.exitCode = previousExitCode; }
  });

  it('validates a candidate through the shared plugin action without opening the legacy store', async () => {
    const result = { status: 'validated', candidateId: 'b'.repeat(64), candidateVersion: 1, validatedVersion: 2,
      executionId: 'validation-execution', receiptDigest: 'e'.repeat(64) };
    const dispatchSystemAction = vi.fn().mockResolvedValue(result);
    const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
    await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules', '--json');
    expect(dispatchSystemAction).toHaveBeenCalledWith('learning.validate', { scope, candidateId: test.proposal.id,
      expectedVersion: 1, checkerId: 'approval-rules' });
    expect(JSON.parse(test.printed())).toEqual(result);
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it('returns a blocked validation result with a nonzero exit status', async () => {
    const previousExitCode = process.exitCode;
    try {
      const result = { status: 'blocked', code: 'checker_unavailable' };
      const dispatchSystemAction = vi.fn().mockResolvedValue(result);
      const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
      await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules', '--json');
      expect(JSON.parse(test.printed())).toEqual(result);
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previousExitCode; }
  });

  it.each(['injected', 'factory'] as const)('does not dispose a borrowed %s runtime', async source => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ status: 'validated', validatedVersion: 2 }), dispose: vi.fn() };
    const createRuntime = vi.fn().mockResolvedValue(plugins);
    const test = learningFixture(source === 'injected'
      ? { pluginRuntime: plugins as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> }
      : { createRuntime });
    await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules');
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(source === 'factory' ? 1 : 0);
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
  });

  it.each(['dispatch', 'dispose', 'startup'] as const)('sanitizes %s errors and releases only an owned runtime', async failure => {
    const error = new Error('PRIVATE_TRANSCRIPT credential=PRIVATE_TOKEN');
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ status: 'validated', validatedVersion: 2 }),
      dispose: vi.fn().mockResolvedValue(undefined) };
    if (failure === 'dispatch') plugins.dispatchSystemAction.mockRejectedValue(error);
    if (failure === 'dispose') plugins.dispose.mockRejectedValue(error);
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    if (failure === 'startup') runtime.createCliPluginRuntime.mockRejectedValue(error);
    const test = learningFixture();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    await expect(test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules'))
      .rejects.toThrow(/^Learning validation failed$/);
    expect(plugins.dispose).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
    expect(test.printed()).not.toContain('PRIVATE_');
  });

  it('lazily creates and releases the default runtime for a successful validation', async () => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ status: 'validated', validatedVersion: 2 }),
      dispose: vi.fn().mockResolvedValue(undefined) };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = learningFixture();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules');
    expect(runtime.createCliPluginRuntime).toHaveBeenCalledOnce();
    expect(plugins.dispose).toHaveBeenCalledOnce();
  });

  it.each(['0', '-1', '1.5', '9007199254740992'])('rejects invalid validation version %s before selecting a runtime', async version => {
    const dispatchSystemAction = vi.fn();
    const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
    await expect(test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', version, '--checker', 'approval-rules')).rejects.toThrow();
    expect(dispatchSystemAction).not.toHaveBeenCalled();
  });

  it.each(['jobs', 'candidates'])('returns existing %s DTOs without opening the experience store', async command => {
    const test = learningFixture();
    await test.parse(command, '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(command === 'jobs' ? cliJobs(test.state.jobs) : test.state.candidates);
    expect(test.query).toHaveBeenCalledWith({ directory: '/tmp/afk-learning-command-test', scope });
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
  });

  it.each(['jobs', 'candidates', 'inspect'])('prefers the existing plugin action for %s', async command => {
    const dispatchSystemAction = vi.fn();
    const pluginRuntime = { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']>;
    const test = learningFixture({ pluginRuntime });
    dispatchSystemAction.mockResolvedValue(command === 'jobs' ? test.state.jobs : test.state.candidates);
    await test.parse(command, ...(command === 'inspect' ? [test.proposal.id] : []), '--scope', scope, '--json');
    expect(dispatchSystemAction).toHaveBeenCalledOnce();
    expect(dispatchSystemAction).toHaveBeenCalledWith(`learning.${command === 'jobs' ? 'jobs' : 'candidates'}`, { scope });
    expect(test.query).not.toHaveBeenCalled();
    expect(runtime.learningDirectory).not.toHaveBeenCalled();
    expect(JSON.parse(test.printed())).toEqual(command === 'inspect' ? test.proposal : command === 'jobs' ? cliJobs(test.state.jobs) : test.state.candidates);
  });

  it.each([false, true].flatMap(foreign => [
    { foreign, artifact: false }, { foreign, artifact: true },
  ]))('projects a scoped receipt (foreign: $foreign, artifact: $artifact)', async ({ foreign, artifact }) => {
    const dispatchSystemAction = vi.fn();
    const pluginRuntime = { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']>;
    const test = learningFixture({ pluginRuntime });
    const receipt = { kind: 'tool', scope: foreign ? `${scope}-foreign` : scope, candidateId: test.proposal.id,
      candidateVersion: 1, validatedVersion: 2, candidateDigest: test.proposal.digest, evidenceDigest: test.proposal.evidenceDigest,
      checkerId: 'behavior', executionId: 'e7669c6b-d9af-4a4d-9444-a98fad93062e', receiptDigest: 'a'.repeat(64),
      repositoryDigest: 'b'.repeat(64), commit: 'c'.repeat(40), artifactPath: 'tools/verify.mjs', artifactDigest: 'd'.repeat(64),
      originalArtifactDigest: null, ...(artifact ? { source: 'export default 42;' } : {}) };
    dispatchSystemAction.mockResolvedValue({ ...receipt, configurationFile: '/private/checker.json' });
    const result = test.parse('inspect', test.proposal.id, '--scope', scope, artifact ? '--proposal-artifact' : '--proposal-receipt', '--json');
    if (foreign) {
      await expect(result).rejects.toThrow(artifact ? 'Validated proposal artifact unavailable in scope' : 'Proposal validation receipt unavailable in scope');
      expect(test.printed()).toBe('');
    } else {
      await result;
      expect(JSON.parse(test.printed())).toEqual(receipt);
    }
    expect(dispatchSystemAction).toHaveBeenCalledOnce();
    expect(dispatchSystemAction).toHaveBeenCalledWith('learning.proposal.receipt', { scope, candidateId: test.proposal.id, ...(artifact ? { artifact: {} } : {}) });
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['jobs', 'candidates'])('filters %s to the exact scope before sorting and pagination', async command => {
    const test = learningFixture();
    const foreignScope = `${scope}-foreign`;
    test.state.jobs = [{ ...test.job, jobId: '0'.repeat(64), scope: foreignScope },
      { ...test.job, jobId: 'f'.repeat(64) }, test.job, { ...test.job, jobId: '1'.repeat(64) }];
    test.state.candidates = [{ ...test.proposal, id: '0'.repeat(64), proposal: { ...test.proposal.proposal,
      applicability: { ...test.proposal.proposal.applicability, project: foreignScope } } },
    { ...test.proposal, id: 'f'.repeat(64) }, test.proposal, { ...test.proposal, id: '1'.repeat(64) }];
    const original = structuredClone(test.state);
    await test.parse(command, '--scope', scope, '--limit', '1', '--offset', '1', '--json');
    expect(JSON.parse(test.printed())).toEqual(command === 'jobs' ? cliJobs([test.job]) : [test.proposal]);
    expect(test.state).toEqual(original);
  });

  it.each(['jobs', 'candidates'])('bounds %s pages at 100 and supports zero and safe-integer offsets', async command => {
    const test = learningFixture();
    test.state.jobs = Array.from({ length: 102 }, (_, index) => ({ ...test.job, jobId: index.toString(16).padStart(64, '0') })).reverse();
    test.state.candidates = Array.from({ length: 102 }, (_, index) => ({ ...test.proposal, id: index.toString(16).padStart(64, '0') })).reverse();
    await test.parse(command, '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toHaveLength(100);
    test.output.length = 0;
    await test.parse(command, '--scope', scope, '--limit', '100', '--offset', '100', '--json');
    const rows = command === 'jobs' ? cliJobs(test.state.jobs) : test.state.candidates;
    expect(JSON.parse(test.printed())).toEqual(rows.slice(0, 2).reverse());
    test.output.length = 0;
    await test.parse(command, '--scope', scope, '--limit', '0', '--offset', '0', '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    test.output.length = 0;
    await test.parse(command, '--scope', scope, '--limit', '100', '--offset', String(Number.MAX_SAFE_INTEGER), '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
  });

  it.each(['jobs', 'candidates', 'inspect'])('requires an exact canonical scope for %s before querying', async command => {
    const test = learningFixture();
    const args = command === 'inspect' ? [test.proposal.id] : [];
    await expect(test.parse(command, ...args)).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    for (const invalid of ['acme/project', 'github:acme/project#42', ' github:acme/project', 'github:acme/project ', 'github:acme/project\n']) {
      await expect(test.parse(command, ...args, '--scope', invalid)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    }
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['jobs', 'candidates'])('rejects malformed %s pagination before querying', async command => {
    const test = learningFixture();
    for (const flag of ['--limit', '--offset']) {
      for (const invalid of ['-1', '1.5', '1e2', '0x10', 'NaN', 'Infinity', '', ' 1', '1\n', '9007199254740992']) {
        await expect(test.parse(command, '--scope', scope, flag, invalid)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
      }
    }
    await expect(test.parse(command, '--scope', scope, '--limit', '101')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), ` ${'a'.repeat(64)}`, `${'a'.repeat(64)}\n`, '../candidate'])
    ('rejects noncanonical candidate IDs: %j', async id => {
      const test = learningFixture();
      await expect(test.parse('inspect', id, '--scope', scope)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
      expect(test.query).not.toHaveBeenCalled();
    });

  it('inspects the complete existing DTO and refuses absent or foreign candidates identically', async () => {
    const test = learningFixture();
    await test.parse('inspect', test.proposal.id, '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(test.proposal);
    test.output.length = 0;
    await expect(test.parse('inspect', 'e'.repeat(64), '--scope', scope)).rejects.toThrow('Candidate not found in scope');
    test.proposal.proposal.applicability.project = `${scope}-foreign`;
    await expect(test.parse('inspect', test.proposal.id, '--scope', scope)).rejects.toThrow('Candidate not found in scope');
    expect(test.printed()).toBe('');
  });

  it.each([true, false])('preserves storage-blocked diagnostics in jobs (json=%s)', async json => {
    const test = learningFixture();
    test.job.reasonCode = 'storage_blocked';
    test.job.attempts = [{ requestKey: test.job.jobId, callId: 'storage-call', day: '2026-11-10',
      startedAt: '2026-11-10T00:00:00Z', ownerPid: 42, host: 'local-host', status: 'failed', errorCode: 'storage_blocked' }];
    await test.parse('jobs', '--scope', scope, ...(json ? ['--json'] : []));
    if (json) expect(JSON.parse(test.printed())).toEqual(cliJobs([test.job]));
    else expect(test.printed()).toBe(`${test.job.jobId} [blocked] storage_blocked\n`);
  });

  it('prints only compact identities, statuses and safe stage codes', async () => {
    const test = learningFixture();
    test.job.sourceId = 'SENSITIVE_TRANSCRIPT';
    test.proposal.proposal.statement = 'SENSITIVE_TRANSCRIPT';
    await test.parse('jobs', '--scope', scope);
    await test.parse('candidates', '--scope', scope);
    await test.parse('inspect', test.proposal.id, '--scope', scope);
    expect(test.printed()).toBe(`${test.job.jobId} [blocked] budget_exhausted\n${test.proposal.id} [candidate]\n${test.proposal.id} [candidate]\n`);
    test.output.length = 0;
    test.job.reasonCode = 'authorization: Bearer PRIVATE_TOKEN\nRAW_TRANSCRIPT';
    await test.parse('jobs', '--scope', scope);
    expect(test.printed()).toBe(`${test.job.jobId} [blocked]\n`);
  });

  it.each(['jobs', 'candidates', 'inspect'])('emits only existing %s DTO fields, never pack or credential extensions', async command => {
    const test = learningFixture();
    const expected = structuredClone(command === 'jobs' ? cliJobs(test.state.jobs) : command === 'inspect' ? test.proposal : test.state.candidates);
    Object.assign(test.job, { pack: { content: 'PRIVATE_PACK_BODY' }, credentials: 'PRIVATE_TOKEN' });
    Object.assign(test.proposal, { pack: { content: 'PRIVATE_PACK_BODY' }, credentials: 'PRIVATE_TOKEN' });
    await test.parse(command, ...(command === 'inspect' ? [test.proposal.id] : []), '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(expected);
    expect(test.printed()).not.toMatch(/PRIVATE_PACK_BODY|PRIVATE_TOKEN/);
  });

  it('omits free-form blocked reasons from JSON instead of dumping sensitive transcripts', async () => {
    const test = learningFixture();
    test.job.reasonCode = 'RAW_TRANSCRIPT authorization: Bearer PRIVATE_TOKEN';
    await test.parse('jobs', '--scope', scope, '--json');
    const { reasonCode, canRun, ...expected } = test.job;
    expect(JSON.parse(test.printed())).toEqual([expected]);
    expect(test.printed()).not.toContain('PRIVATE_TOKEN');
  });

  it.each(['analysis_failed', 'analysis_executable_changed'])('preserves %s on the job and attempt while excluding extension fields', async errorCode => {
    const test = learningFixture();
    test.job.reasonCode = errorCode;
    const attempt = { requestKey: test.job.jobId, callId: 'analysis-call', day: '2026-11-10', startedAt: '2026-11-10T00:00:00Z',
      ownerPid: 42, host: 'local-host', status: 'failed' as const, analysisRunId: 'analysis-run', sessionId: 'analysis-session',
      finishedAt: '2026-11-10T00:00:01Z', errorCode, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
    const pending = { requestKey: test.job.jobId, callId: 'pending-call', day: attempt.day, startedAt: attempt.startedAt,
      ownerPid: 42, host: 'local-host', status: 'started' as const };
    test.job.attempts = [structuredClone(attempt), pending];
    Object.assign(test.job.attempts[0], { transcript: 'PRIVATE_TRANSCRIPT' });
    Object.assign(test.job.attempts[0].usage!, { credentials: 'PRIVATE_TOKEN' });
    await test.parse('jobs', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())[0]).toMatchObject({ reasonCode: errorCode });
    expect(JSON.parse(test.printed())[0].attempts).toEqual([attempt, pending]);
    expect(test.printed()).not.toMatch(/PRIVATE_TRANSCRIPT|PRIVATE_TOKEN/);
  });

  it('fails closed on invalid job status or candidate proposal without dumping the DTO', async () => {
    const test = learningFixture();
    Object.assign(test.job, { status: 'PRIVATE_TRANSCRIPT' });
    await expect(test.parse('jobs', '--scope', scope, '--json')).rejects.toThrow(/^Learning query failed$/);
    Object.assign(test.proposal.proposal, { credentials: 'PRIVATE_TOKEN' });
    await expect(test.parse('candidates', '--scope', scope, '--json')).rejects.toThrow(/^Learning query failed$/);
    expect(test.printed()).toBe('');
  });

  it('does not manufacture fallback data when the injected runtime has no learning action', async () => {
    const { PluginRuntime } = await import('@afk/runtime/plugin-sdk');
    const pluginRuntime = new PluginRuntime();
    try {
      const test = learningFixture({ pluginRuntime });
      await expect(test.parse('jobs', '--scope', scope, '--json')).rejects.toThrow(/^Learning query failed$/);
      expect(test.query).not.toHaveBeenCalled();
      expect(test.printed()).toBe('');
    } finally { await pluginRuntime.dispose(); }
  });

  it.each(['jobs', 'candidates', 'inspect'])('never dumps query errors or falls back after a failed plugin %s action', async command => {
    const dispatchSystemAction = vi.fn().mockRejectedValue(new Error('RAW_TRANSCRIPT credential=PRIVATE_TOKEN'));
    const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as ExperienceCommandComposition['pluginRuntime'] });
    await expect(test.parse(command, ...(command === 'inspect' ? [test.proposal.id] : []), '--scope', scope, '--json'))
      .rejects.toThrow(/^Learning query failed$/);
    expect(test.query).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it('sanitizes fallback errors without retaining the raw error as a cause', async () => {
    const test = learningFixture();
    test.query.mockImplementation(() => { throw new Error('RAW_TRANSCRIPT credential=PRIVATE_TOKEN'); });
    const error = await test.parse('jobs', '--scope', scope, '--json').catch(error => error);
    expect(error.message).toBe('Learning query failed');
    expect(error.cause).toBeUndefined();
    expect(test.printed()).toBe('');
  });

  it('uses the real runtime query on a missing ledger without creating directories, ledgers or workers', async () => {
    const actual = await vi.importActual<typeof import('@afk/runtime/execution')>('@afk/runtime/execution');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-cli-'));
    directories.push(root);
    const directory = join(root, 'missing-learning');
    runtime.learningDirectory.mockReturnValueOnce(directory).mockReturnValueOnce(directory).mockReturnValueOnce(directory);
    runtime.queryLearningState.mockImplementation(actual.queryLearningState);
    const worker = vi.spyOn(actual.LearningWorker.prototype, 'runOnce');
    const test = learningFixture({ queryLearningState: undefined });
    await test.parse('jobs', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    test.output.length = 0;
    await test.parse('candidates', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    await expect(test.parse('inspect', test.proposal.id, '--scope', scope)).rejects.toThrow('Candidate not found in scope');
    expect(existsSync(directory)).toBe(false);
    expect(runtime.queryLearningState).toHaveBeenCalledTimes(3);
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it('reads a real submitted job without exposing its evidence pack or creating a worker queue', async () => {
    const actual = await vi.importActual<typeof import('@afk/runtime/execution')>('@afk/runtime/execution');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-cli-'));
    directories.push(root);
    const file = join(root, 'evidence.txt');
    writeFileSync(file, 'PRIVATE_EVIDENCE_PACK_BODY');
    const pack = await actual.buildEvidencePack({ sources: [{ id: 'source-1', kind: 'journal', path: file, allowedRoot: root, format: 'text' }] });
    const directory = join(root, 'learning');
    await actual.submitDistillation({ directory, pack, request: { version: 1, scope, sourceId: 'run:42', evidenceDigest: pack.digest,
      analyzerVersion: '1', reason: 'completed' } });
    const before = readFileSync(join(directory, 'candidates.sqlite'));
    const test = learningFixture({ queryLearningState: input => actual.queryLearningState({ ...input, directory }) });
    await test.parse('jobs', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(cliJobs(actual.queryLearningState({ directory, scope }).jobs));
    expect(test.printed()).not.toContain('PRIVATE_EVIDENCE_PACK_BODY');
    expect(readFileSync(join(directory, 'candidates.sqlite'))).toEqual(before);
    expect(existsSync(join(directory, 'distillation-queue.sqlite'))).toBe(false);
  });
});

describe('experience outcome queries', () => {
  const args = ['outcomes', '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId];

  it.each([undefined, '0', '100'])('reads a bounded run and work-item pair without activating plugins (limit=%s)', async limit => {
    const test = fixture();
    await test.parse(...args, ...(limit === undefined ? [] : ['--limit', limit]), '--json');
    expect(test.store.outcomeReceipts).toHaveBeenCalledWith({ scope, source: { runId: 'using-run', workItemId }, limit: Number(limit ?? 20) });
    expect(JSON.parse(test.printed())).toEqual([]);
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    expect(runtime.verifyAdoptionRun).not.toHaveBeenCalled();
    expect(test.store.recall).not.toHaveBeenCalled();
    expect(test.store.adopt).not.toHaveBeenCalled();
  });

  it.each(['--scope', '--run-id', '--work-item-id'])('requires %s before opening storage', async flag => {
    const test = fixture();
    const index = args.indexOf(flag);
    await expect(test.parse(...args.filter((_, position) => position !== index && position !== index + 1))).rejects.toThrow();
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['-1', '101', '1.5', '1e1', 'Infinity', '9007199254740992'])('rejects invalid limit %s before opening storage', async limit => {
    const test = fixture();
    await expect(test.parse(...args, '--limit', limit)).rejects.toThrow();
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['github:other/project#42', `${scope}#0`, '42'])('rejects foreign or invalid work item %s before opening storage', async id => {
    const test = fixture();
    await expect(test.parse(...args.slice(0, -1), id)).rejects.toThrow();
    expect(test.createStore).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it.each(['query', 'close'] as const)('closes storage and suppresses private %s failures', async failure => {
    const test = fixture();
    const fail = () => { throw new Error('PRIVATE_TOKEN /private/database.sqlite'); };
    if (failure === 'query') test.store.outcomeReceipts.mockImplementation(fail);
    else test.store.close.mockImplementation(fail);
    await expect(test.parse(...args)).rejects.toThrow(/^Experience outcome query failed$/);
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it('reads exact persisted history after reopen without changing selection, adoption or recurrence counts', async () => {
    const actual = await vi.importActual<typeof import('@afk/runtime/execution')>('@afk/runtime/execution');
    const directory = mkdtempSync(join(tmpdir(), 'experience-cli-outcomes-'));
    directories.push(directory);
    const file = join(directory, 'experience.sqlite');
    const source = { runId: 'using-run', workItemId };
    const initial = new actual.ExperienceStore({ file, now: () => new Date('2026-11-17T00:00:00.000Z') });
    let expected: ReturnType<ExperienceStore['outcomeReceipts']>;
    let metrics: ReturnType<ExperienceStore['metrics']>;
    try {
      const record = initial.recordFailure({ scope, trigger: candidate.trigger, rootCause: candidate.rootCause,
        action: candidate.action, source: candidate.source, evidence: candidate.evidence });
      initial.verify(record.id, { runId: 'independent-qa', evidence: ['evidence://independent-qa/passed'] });
      const retrieved = initial.recordContextRetrieval({ id: record.id, scope, source,
        selectionId: '12345678-1234-4234-8234-123456789012', fragmentDigest: 'a'.repeat(64) });
      initial.recordContextSelection({ retrieved, fragmentDigest: 'b'.repeat(64) });
      expected = initial.recordRunOutcome({ scope, source, event: { runId: source.runId, sequence: 3, hash: 'c'.repeat(64),
        type: 'qa.failed', outcome: 'failed', occurredAt: '2026-11-17T00:00:01.000Z', observedAt: '2026-11-17T00:00:01.000Z' },
        failure: { scope, trigger: candidate.trigger, rootCause: candidate.rootCause, action: candidate.action,
          source, evidence: ['evidence://recurrence'] } }).receipts;
      expect(expected).toHaveLength(1);
      expect(expected[0]).toMatchObject({ recurrence: true, benefit: 'unknown' });
      metrics = initial.metrics({ scope });
    } finally { initial.close(); }
    const test = learningFixture({ createStore: () => new actual.ExperienceStore({ file }) });
    await test.parse(...args, '--json');
    expect(JSON.parse(test.printed())).toEqual(expected!);
    expect(test.printed()).not.toContain('\n ');
    const pretty = learningFixture({ createStore: () => new actual.ExperienceStore({ file }) });
    await pretty.parse(...args);
    expect(JSON.parse(pretty.printed())).toEqual(expected!);
    expect(pretty.printed()).toContain('\n ');
    pretty.output.length = 0;
    await pretty.parse(...args.slice(0, -1), `${scope}#43`, '--json');
    expect(JSON.parse(pretty.printed())).toEqual([]);
    const reopened = new actual.ExperienceStore({ file });
    try {
      expect(reopened.metrics({ scope })).toEqual(metrics!);
      expect(reopened.metrics({ scope }).adoptions).toBe(0);
      expect(reopened.outcomeReceipts({ scope, source })).toEqual(expected!);
    } finally { reopened.close(); }
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
  });
});

describe('experience governance commands', () => {
  it('runs portable export to stdout or a new file and never overwrites an existing file', async () => {
    const test = fixture();
    await test.parse('export', '--scope', scope, '--limit', '10');
    expect(test.store.export).toHaveBeenCalledWith({ scope, limit: 10 });
    expect(JSON.parse(test.printed())).toEqual({ version: 1, scope, experiences: [] });
    const root = mkdtempSync(join(tmpdir(), 'experience-cli-'));
    directories.push(root);
    const file = join(root, 'lessons.json');
    await test.parse('export', '--scope', scope, '--output', file);
    expect(readFileSync(file, 'utf8')).toBe(`${test.store.export()}\n`);
    await expect(test.parse('export', '--scope', scope, '--output', file)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(test.store.close).toHaveBeenCalledTimes(3);
  });

  it('reads bounded UTF-8 JSON for candidate import into an explicit target scope', async () => {
    const test = fixture();
    const root = mkdtempSync(join(tmpdir(), 'experience-cli-'));
    directories.push(root);
    const file = join(root, 'lessons.json');
    const json = test.store.export();
    writeFileSync(file, json);
    await test.parse('import', '--scope', scope, '--file', file);
    expect(test.store.import).toHaveBeenCalledWith({ scope, json });
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('rejects oversized, non-file, missing, and invalid UTF-8 input before opening the store', async () => {
    const test = fixture();
    const root = mkdtempSync(join(tmpdir(), 'experience-cli-'));
    directories.push(root);
    const file = join(root, 'lessons.json');
    await expect(test.parse('import', '--scope', scope, '--file', root)).rejects.toThrow('regular JSON file');
    await expect(test.parse('import', '--scope', scope, '--file', file)).rejects.toMatchObject({ code: 'ENOENT' });
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    await expect(test.parse('import', '--scope', scope, '--file', file)).rejects.toThrow('1048576');
    writeFileSync(file, Buffer.from([0xff]));
    await expect(test.parse('import', '--scope', scope, '--file', file)).rejects.toThrow();
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('runs explicit cross-project copying and distinguishes metrics from adoption', async () => {
    const test = fixture();
    const targetScope = 'github:acme/target';
    await test.parse('copy', candidate.id, '--scope', scope, '--target-scope', targetScope);
    expect(test.store.copy).toHaveBeenCalledWith({ id: candidate.id, scope, targetScope });
    await test.parse('metrics', '--scope', scope, '--json');
    expect(test.store.metrics).toHaveBeenCalledWith({ scope });
    await test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId);
    expect(test.store.adopt).toHaveBeenCalledWith({ id: candidate.id, scope, source: { runId: 'using-run', workItemId } }, { actual: {} });
    expect(runtime.verifyAdoptionRun).toHaveBeenCalledWith({ scope, runId: 'using-run', workItemId });
    expect(test.store.close).toHaveBeenCalledTimes(3);
  });

  it('awaits the exact-task audit guard before counting an explicit acknowledgement', async () => {
    const test = fixture();
    let finish!: (context: ExperienceAdoptionContext) => void;
    runtime.verifyAdoptionRun.mockImplementation(() => new Promise<ExperienceAdoptionContext>(resolve => { finish = resolve; }));
    const pending = test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId, '--root', '/tmp/adoption-events');
    expect(runtime.verifyAdoptionRun).toHaveBeenCalledWith({ scope, runId: 'using-run', workItemId, root: '/tmp/adoption-events' });
    expect(test.store.adopt).not.toHaveBeenCalled();
    expect(test.store.close).not.toHaveBeenCalled();
    finish({ actual: {} });
    await pending;
    expect(test.store.adopt).toHaveBeenCalledOnce();
    expect(test.store.adopt).toHaveBeenCalledWith({ id: candidate.id, scope, source: { runId: 'using-run', workItemId } }, { actual: {} });
    expect(JSON.parse(test.printed())).toEqual(test.store.adopt.mock.results[0]?.value);
    expect(JSON.parse(test.printed()).receipt.contextStatus).toBe('unavailable');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('prints the persisted task and exact publication binding from a version-two adoption receipt', async () => {
    const test = fixture();
    const result: ReturnType<ExperienceStore['adopt']> = {
      retrievals: 3, adoptions: 2, recurrences: 2,
      receipt: { binding: 'verified-version', version: 2, experienceId: candidate.id, scope,
        source: { runId: 'using-run', workItemId }, verificationDigest: 'a'.repeat(64), contextDigest: 'b'.repeat(64),
        contextStatus: 'recorded', acknowledgedAt: '2026-11-16T10:00:00.000Z',
        publication: { key: 'c'.repeat(64), candidateId: 'd'.repeat(64), validatedVersion: 3,
          candidateDigest: 'e'.repeat(64), evidenceDigest: 'f'.repeat(64), validatorVersion: 'lesson-checker-v1', targetRef: 'knowledge://lesson' } },
    };
    test.store.adopt.mockReturnValue(result);
    await test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId);
    expect(JSON.parse(test.printed())).toEqual(result);
    expect(test.store.adopt).toHaveBeenCalledWith({ id: candidate.id, scope, source: result.receipt.source }, { actual: {} });
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('reopens the real ledger and emits the same persisted receipt through the CLI without recounting', async () => {
    const actual = await vi.importActual<typeof import('@afk/runtime/execution')>('@afk/runtime/execution');
    const directory = mkdtempSync(join(tmpdir(), 'experience-cli-adoption-'));
    directories.push(directory);
    const file = join(directory, 'experience.sqlite');
    const initial = new actual.ExperienceStore({ file });
    let id: string;
    try {
      const record = initial.recordFailure({ scope, trigger: candidate.trigger, rootCause: candidate.rootCause,
        action: candidate.action, source: candidate.source, evidence: candidate.evidence });
      id = record.id;
      initial.verify(id, { runId: 'independent-qa', evidence: ['evidence://independent-qa/passed'] });
    } finally { initial.close(); }
    const test = learningFixture({ createStore: () => new actual.ExperienceStore({ file }) });
    await test.parse('adopt', id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId);
    const result = JSON.parse(test.printed());
    expect(result).toMatchObject({ adoptions: 1, receipt: { binding: 'verified-version', version: 2,
      experienceId: id, scope, source: { runId: 'using-run', workItemId }, contextStatus: 'unavailable' } });
    expect(result.receipt).not.toHaveProperty('publication');
    const sqlite = createRequire(import.meta.url)(`node:${'sqlite'}`) as {
      DatabaseSync: new (file: string, options: { readOnly: boolean }) => {
        prepare(query: string): { all(id: string): Array<{ evidence_hash: unknown }> }; close(): void;
      };
    };
    const persisted = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      const rows = persisted.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").all(id);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]!.evidence_hash))).toEqual({ version: 2, source: result.receipt.source,
        verificationDigest: result.receipt.verificationDigest, contextDigest: result.receipt.contextDigest,
        acknowledgedAt: result.receipt.acknowledgedAt });
    } finally { persisted.close(); }
    const reopened = new actual.ExperienceStore({ file });
    try {
      expect(reopened.metrics({ scope }).adoptions).toBe(1);
      expect(reopened.adopt({ id, scope, source: { runId: 'using-run', workItemId } })).toEqual(result);
      expect(reopened.metrics({ scope }).adoptions).toBe(1);
    } finally { reopened.close(); }
    test.output.length = 0;
    await test.parse('adopt', id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId);
    expect(JSON.parse(test.printed())).toEqual(result);
    expect(runtime.verifyAdoptionRun).toHaveBeenCalledTimes(2);
  });

  it('forwards distinct actual and QA-verified contexts intact to the adoption ledger', async () => {
    const test = fixture();
    const context: ExperienceAdoptionContext = {
      actual: { applicability: { environment: 'local' }, target: { project: scope, revision: 'b'.repeat(40), dirty: true } },
      verified: { applicability: { environment: 'ci' }, target: { project: scope, revision: 'a'.repeat(40), dirty: false } },
    };
    runtime.verifyAdoptionRun.mockResolvedValue(context);
    await test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId);
    expect(test.store.adopt).toHaveBeenCalledWith({ id: candidate.id, scope, source: { runId: 'using-run', workItemId } }, context);
    expect(test.store.adopt.mock.calls[0]?.[1]).toBe(context);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('forwards an active trusted snapshot without fabricating QA verification', async () => {
    const test = fixture();
    const context: ExperienceAdoptionContext = {
      actual: { applicability: { environment: 'local' }, target: { project: scope, revision: 'b'.repeat(40), dirty: true } },
    };
    runtime.verifyAdoptionRun.mockResolvedValue(context);
    await test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'active-run', '--work-item-id', workItemId);
    expect(test.store.adopt).toHaveBeenCalledWith({ id: candidate.id, scope, source: { runId: 'active-run', workItemId } }, context);
    expect(test.store.adopt.mock.calls[0]?.[1]).toBe(context);
    expect(context).not.toHaveProperty('verified');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['missing run', 'wrong work item', 'foreign scope', 'corrupt run'])('does not count an acknowledgement when the audit guard rejects: %s', async reason => {
    const test = fixture();
    runtime.verifyAdoptionRun.mockRejectedValue(new Error(reason));
    await expect(test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'claimed-run', '--work-item-id', workItemId)).rejects.toThrow(reason);
    expect(test.store.adopt).not.toHaveBeenCalled();
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each(['export', 'import', 'copy', 'metrics', 'adopt'])('provides actionable help for %s', command => {
    const test = fixture();
    const group = test.program.commands.find(entry => entry.name() === 'experience')!;
    const help = group.commands.find(entry => entry.name() === command)!.helpInformation();
    expect(help).toContain('--scope <project>');
    expect(help).toContain('--help');
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('lists only scoped records and passes status and numeric limit to the store', async () => {
    const test = fixture();
    await test.parse('list', '--scope', scope, '--status', 'candidate', '--limit', '3', '--json');
    expect(test.store.list).toHaveBeenCalledWith({ scope, status: 'candidate', limit: 3 });
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('prints a readable inventory when JSON is not requested', async () => {
    const test = fixture();
    await test.parse('list', '--scope', scope);
    expect(test.printed()).toContain(candidate.id);
    expect(test.printed()).toContain('candidate');
    expect(test.printed()).toContain(candidate.trigger);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('never includes records from another scope in list output', async () => {
    const test = fixture();
    test.store.list.mockReturnValue([candidate, { ...candidate, id: 'foreign', scope: 'github:private/foreign', trigger: 'FOREIGN_CONTENT_SENTINEL' }]);
    await test.parse('list', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.printed()).not.toContain('FOREIGN_CONTENT_SENTINEL');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('recalls using an explicit project scope and query', async () => {
    const test = fixture();
    await test.parse('recall', '--scope', scope, '--query', 'input validation');
    expect(test.store.recall).toHaveBeenCalledWith({ scope, prompt: 'input validation' });
    expect(test.printed()).toContain(candidate.id);
    expect(test.printed()).toContain('verified');
    expect(test.printed()).toContain(candidate.action);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('passes validated applicability and target context to scoped recall', async () => {
    const test = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'experience-recall-context-'));
    directories.push(directory);
    const file = join(directory, 'context.json');
    const context = { applicability: { version: 'v2', environment: 'local' },
      target: { project: scope, conditions: { retry: true } } };
    writeFileSync(file, JSON.stringify(context));
    await test.parse('recall', '--scope', scope, '--query', 'input validation', '--context', file, '--json');
    expect(test.store.recall).toHaveBeenCalledWith({ scope, prompt: 'input validation', ...context });
    expect(JSON.parse(test.printed())).toHaveLength(1);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each([
    '{',
    JSON.stringify({ applicability: { version: 2 } }),
    JSON.stringify({ target: { project: 'github:private/foreign' } }),
    JSON.stringify({ authorization: 'PRIVATE_CONTEXT_SENTINEL' }),
    JSON.stringify({ applicability: { version: 'PRIVATE_CONTEXT_SENTINEL'.repeat(1600) } }),
  ])('rejects invalid recall context without opening storage or echoing content: %#', async content => {
    const test = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'experience-recall-invalid-'));
    directories.push(directory);
    const file = join(directory, 'context.json');
    writeFileSync(file, content);
    await expect(test.parse('recall', '--scope', scope, '--query', 'input validation', '--context', file))
      .rejects.toThrow('Experience recall context is invalid');
    expect(test.createStore).not.toHaveBeenCalled();
    expect(test.store.recall).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it('records a manual candidate with canonical work identity and all evidence references', async () => {
    const test = fixture();
    await test.parse('record', '--scope', scope, '--trigger', candidate.trigger, '--root-cause', candidate.rootCause,
      '--action', candidate.action, '--run-id', candidate.source.runId, '--work-item-id', workItemId,
      '--evidence', 'evidence://failure', 'evidence://logs');
    expect(test.store.recordFailure).toHaveBeenCalledWith({ scope, trigger: candidate.trigger, rootCause: candidate.rootCause,
      action: candidate.action, source: candidate.source, evidence: ['evidence://failure', 'evidence://logs'] });
    expect(test.records.at(-1)).toMatchObject({ status: 'candidate', source: candidate.source, scope });
    expect(test.printed()).toBe('Recorded candidate recorded-experience\n');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['github:other/project#42', '42', `${scope}#042`])('rejects foreign or noncanonical record identity %s before opening the store', async identity => {
    const test = fixture();
    await expect(test.parse('record', '--scope', scope, '--trigger', 'failure', '--root-cause', 'cause', '--action', 'fix',
      '--run-id', 'run', '--work-item-id', identity, '--evidence', 'evidence://failure')).rejects.toThrow();
    expect(test.createStore).not.toHaveBeenCalled();
    expect(test.store.recordFailure).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it('verifies only a record found in the explicit scope and applies correction evidence', async () => {
    const test = fixture();
    await test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'check before write',
      '--evidence', 'evidence://successful-test', 'evidence://review');
    expect(test.store.get).toHaveBeenCalledWith(candidate.id, scope);
    expect(runtime.verifyExperienceRun).toHaveBeenCalledWith({ scope, runId: 'successful-run', evidence: ['evidence://successful-test', 'evidence://review'] });
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'check before write', evidence: ['evidence://successful-test', 'evidence://review', 'run:successful-run#qa.passed'] });
    expect(test.records[0]).toMatchObject({ status: 'verified', action: 'check before write' });
    expect(test.printed()).toBe(`Verified experience ${candidate.id}\n`);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('can verify a scoped record outside the bounded list and forward a corrected root cause', async () => {
    const test = fixture();
    test.store.list.mockReturnValue([]);
    await test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix',
      '--root-cause', 'corrected cause', '--evidence', 'evidence://qa');
    expect(test.store.get).toHaveBeenCalledWith(candidate.id, scope);
    expect(test.store.list).not.toHaveBeenCalled();
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'fix', rootCause: 'corrected cause', evidence: ['evidence://qa', 'run:successful-run#qa.passed'] });
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('revokes a record only after checking its scope', async () => {
    const test = fixture();
    await test.parse('revoke', candidate.id, '--scope', scope);
    expect(test.store.get).toHaveBeenCalledWith(candidate.id, scope);
    expect(test.store.revoke).toHaveBeenCalledWith(candidate.id);
    expect(test.records[0].status).toBe('revoked');
    expect(test.printed()).toBe(`Revoked experience ${candidate.id}\n`);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['verify', 'revoke'])('%s never mutates or reveals a foreign record even when lookup returns it', async command => {
    const test = fixture();
    test.store.get.mockReturnValue({ ...candidate, scope: 'github:private/foreign', trigger: 'FOREIGN_CONTENT_SENTINEL' });
    const args = command === 'verify' ? ['--run-id', 'run', '--action', 'fix', '--evidence', 'evidence://test'] : [];
    await expect(test.parse(command, candidate.id, '--scope', scope, ...args)).rejects.toThrow('Experience not found in scope');
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.revoke).not.toHaveBeenCalled();
    expect(runtime.verifyExperienceRun).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['verify', 'revoke'])('%s uses the same safe error for a missing record', async command => {
    const test = fixture();
    const args = command === 'verify' ? ['--run-id', 'run', '--action', 'fix', '--evidence', 'evidence://test'] : [];
    await expect(test.parse(command, 'missing', '--scope', scope, ...args)).rejects.toThrow('Experience not found in scope');
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.revoke).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('does not inspect run evidence or mutate when the scoped lookup fails', async () => {
    const test = fixture();
    const failure = new Error('scoped lookup unavailable');
    test.store.get.mockImplementation(() => { throw failure; });
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix', '--evidence', 'evidence://qa')).rejects.toBe(failure);
    expect(runtime.verifyExperienceRun).not.toHaveBeenCalled();
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each([
    ['list'], ['recall', '--scope', scope], ['verify', candidate.id, '--scope', scope], ['revoke', candidate.id],
    ['record', '--scope', scope],
  ].map(args => ({ args })))('requires governance arguments before opening the store: $args', async ({ args }) => {
    const test = fixture();
    await expect(test.parse(...args)).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['team/project', 'github:team/project#42', 'gitlab:', 'unknown:team/project'])('rejects invalid scope %s before opening the store', async invalid => {
    const test = fixture();
    await expect(test.parse('list', '--scope', invalid)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['-1', '1.5', '3items', '101', 'Infinity', '9007199254740992'])('rejects invalid limit %s before opening the store', async limit => {
    const test = fixture();
    await expect(test.parse('list', '--scope', scope, '--limit', limit)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('rejects unknown status values before opening the store', async () => {
    const test = fixture();
    await expect(test.parse('list', '--scope', scope, '--status', 'untrusted')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '\0'])('rejects blank or invalid correction %j before opening the store', async action => {
    const test = fixture();
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'run', '--action', action, '--evidence', 'evidence://test')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('rejects empty evidence references before opening the store', async () => {
    const test = fixture();
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'run', '--action', 'fix', '--evidence', '   ')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['list', 'recall', 'record', 'verify', 'revoke'])('closes the store when %s fails and propagates the error to the CLI boundary', async command => {
    const test = fixture();
    const failure = new Error('experience store unavailable');
    const method = command === 'record' ? test.store.recordFailure : test.store[command as 'list' | 'recall' | 'verify' | 'revoke'];
    method.mockImplementation(() => { throw failure; });
    const args = command === 'list' ? [] : command === 'recall' ? ['--query', 'validation'] : command === 'revoke' ? [candidate.id] :
      command === 'verify' ? [candidate.id, '--run-id', 'run', '--action', 'fix', '--evidence', 'evidence://test'] :
        ['--trigger', 'failure', '--root-cause', 'cause', '--action', 'fix', '--run-id', 'run', '--work-item-id', workItemId, '--evidence', 'evidence://failure'];
    await expect(test.parse(command, '--scope', scope, ...args)).rejects.toBe(failure);
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it('uses the runtime store path when no factory is injected', async () => {
    const test = fixture();
    const trustedHomeDir = homedir();
    const program = new Command().exitOverride();
    registerExperienceCommands(program);
    await program.parseAsync(['node', 'afk', 'experience', 'list', '--scope', scope, '--json']);
    expect(runtime.experienceStorePath).toHaveBeenCalledOnce();
    expect(runtime.experienceStorePath).toHaveBeenCalledWith(trustedHomeDir);
    expect(runtime.ExperienceStore).toHaveBeenCalledWith({ file: '/tmp/afk-experience-command-test.sqlite', homeDir: trustedHomeDir });
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('uses the runtime QA guard when no verification override is injected', async () => {
    const test = fixture();
    const program = new Command().exitOverride();
    registerExperienceCommands(program, { createStore: test.createStore as unknown as ExperienceCommandComposition['createStore'] });
    await program.parseAsync(['node', 'afk', 'experience', 'verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix', '--evidence', 'evidence://qa']);
    expect(runtime.verifyExperienceRun).toHaveBeenCalledWith({ scope, runId: 'successful-run', evidence: ['evidence://qa'] });
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'fix', evidence: ['evidence://qa', 'run:successful-run#qa.passed'] });
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('awaits the QA guard before mutation and closes only after verification completes', async () => {
    const test = fixture();
    let finish!: (evidence: string[]) => void;
    runtime.verifyExperienceRun.mockImplementation(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const pending = test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix', '--root', '/tmp/test-events', '--evidence', 'evidence://qa');
    expect(runtime.verifyExperienceRun).toHaveBeenCalledWith({ scope, runId: 'successful-run', evidence: ['evidence://qa'], root: '/tmp/test-events' });
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.close).not.toHaveBeenCalled();
    finish(['evidence://qa', 'run:successful-run#qa.passed']);
    await pending;
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'fix', evidence: ['evidence://qa', 'run:successful-run#qa.passed'] });
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['invalid integrity', 'foreign work item', 'QA failed', 'QA missing'])('denies verification when run evidence fails: %s', async reason => {
    const test = fixture();
    const failure = new Error(reason);
    runtime.verifyExperienceRun.mockRejectedValue(failure);
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'claimed-success', '--action', 'fix', '--evidence', 'claimed-reference')).rejects.toBe(failure);
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.records[0].status).toBe('candidate');
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it('returns recalled records as JSON and excludes any foreign scope', async () => {
    const test = fixture();
    const verified = { ...candidate, status: 'verified' };
    test.store.recall.mockReturnValue([verified, { ...verified, scope: 'github:private/foreign', trigger: 'FOREIGN_CONTENT_SENTINEL' }]);
    await test.parse('recall', '--scope', scope, '--query', 'validation', '--json');
    expect(JSON.parse(test.printed())).toEqual([verified]);
    expect(test.printed()).not.toContain('FOREIGN_CONTENT_SENTINEL');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('accepts the service list bounds including zero results', async () => {
    const test = fixture();
    await test.parse('list', '--scope', scope, '--limit', '0', '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    expect(test.store.list).toHaveBeenCalledWith({ scope, limit: 0, status: undefined });
    expect(test.store.close).toHaveBeenCalledOnce();
  });
});
