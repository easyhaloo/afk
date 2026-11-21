import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent, RunEventData } from '@afk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import type { VerificationProvider } from '../../plugin-sdk/capabilities.js';
import type { AnalysisExecutionInput } from '../learning/analysis-runner.js';
import { CandidateStore } from '../learning/candidate-store.js';
import { knowledgeFixture } from '../learning/knowledge.fixture.spec.js';
import type { LearningRequestState } from '../learning/worker.js';
import { WorkflowRunner, type RunnerDependencies } from '../workflow-engine.js';
import { PlanExecutor } from '../workflows/plan-executor.js';
import { SystemActionExecutor } from '../workflows/system-actions.js';
import { runSuccessReviewWorkflow } from '../workflows/run-cmd.js';
import { createLearningPlugin } from './learning.js';
import { createPluginRunObserver } from './observability.js';
import { PluginRuntime } from './runtime.js';

const analysis = vi.hoisted(() => vi.fn());
vi.mock('../learning/analysis-runner.js', async importOriginal => ({
  ...await importOriginal<typeof import('../learning/analysis-runner.js')>(), executeAnalysis: analysis,
}));
vi.mock('../../infrastructure/config/manager.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../infrastructure/config/manager.js')>(),
  getWorkflowConfig: () => ({ agentDefault: 'unavailable-agent', workflowHardTimeout: 10000, targetBranch: 'main' }),
}));

const runtimes: PluginRuntime[] = [];
const fixtures: ReturnType<typeof knowledgeFixture>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function setup(validObservation = true) {
  const fixture = knowledgeFixture();
  fixtures.push(fixture);
  const scope = fixture.policy.scope;
  const homeDir = join(fixture.root, 'home');
  const directory = join(homeDir, '.afk', 'learning');
  const file = join(directory, 'candidates.sqlite');
  const transcriptPath = join(homeDir, '.afk', 'transcripts', 'retrospective.jsonl');
  mkdirSync(join(homeDir, '.afk', 'transcripts'), { recursive: true });
  writeFileSync(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'Approve before publishing.' } }) + '\n');
  const events = new JsonlEventStore({ root: join(homeDir, '.afk', 'events') });
  for (const runId of ['source-run', 'unrelated-run']) {
    const data: RunEventData[] = [{ kind: 'qa.started' },
      { kind: 'agent.session_recorded', sessionId: 'retrospective-session', transcriptPath },
      { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
    await events.append(data.map(entry => ({ id: randomUUID(), schemaVersion: 1 as const, type: entry.kind,
      context: { traceId: runId, runId, workItemId: `${scope}#42`, profileId: 'fixture', attempt: 1,
        actor: { kind: 'system' as const, id: 'fixture' } },
      occurredAt: new Date().toISOString(), correlationId: runId, data: entry })));
  }
  const payload = { entry: 'Publishing requested', systems: ['publishing'], preconditions: [],
    steps: [{ id: 'approval', action: 'Approve before publishing', stateChange: 'Approved' }],
    exceptions: [], completion: 'Publishing approved' };
  const oracle: { [node: string]: string | string[] } = {
    'process.entry': payload.entry, 'process.systems': payload.systems, 'process.preconditions': payload.preconditions,
    'process.stepCount': String(payload.steps.length),
    'process.applicability.preconditions': [], 'process.applicability.exclusions': [], 'process.applicability.invalidationConditions': ['Approval policy changes'],
    'process.steps.0.action': payload.steps[0]!.action,
    'process.steps.0.stateChange': validObservation ? 'Approved' : 'Rejected',
    'process.exceptions': payload.exceptions, 'process.completion': payload.completion,
  };
  writeFileSync(fixture.validationTargetPath, JSON.stringify(oracle));
  const identity = { scope, checkerId: 'process-checker', providerId: 'process-oracle', version: '1' };
  writeFileSync(fixture.validationConfigurationFile, JSON.stringify({ version: 1, checkers: [{ ...identity,
    authorizationFile: fixture.validationAuthorizationFile,
    target: { ref: 'wiki:approval', root: join(fixture.root, 'oracle'), path: 'approval.json' },
  }] }), { mode: 0o600 });
  const verify = vi.fn(async (request: Parameters<VerificationProvider['verify']>[0]) => {
    const envelope = JSON.parse(request.target) as { binding: unknown; assertions: { node: string; evidence: unknown }[] };
    const observed = JSON.parse(readFileSync(fixture.validationTargetPath, 'utf8')) as typeof oracle;
    return { passed: true, durationMs: 1, output: JSON.stringify({ protocol: 'learning-validation-v1', binding: envelope.binding,
      assertions: envelope.assertions.map(assertion => ({ ...assertion, actual: observed[assertion.node], status: 'observed' })) }) };
  });
  const provider: VerificationProvider = { id: identity.providerId,
    capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
    doctor: async () => [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(identity) }], verify };
  analysis.mockImplementation(async (input: AnalysisExecutionInput) => {
    const store = new CandidateStore({ file });
    try {
      const request = store.getRequest(input.jobId)!;
      const pack = store.getEvidencePack(request.request.evidenceDigest)!;
      const evidenceIds = pack.entries.filter(entry => entry.ref.kind === 'audit').map(entry => entry.ref.id);
      return { analysisRunId: 'synthetic-analysis', sessionId: 'synthetic-session', output: {
        type: 'goal_complete', distillation: { version: 1, warnings: [], candidates: [{ kind: 'process',
          title: 'Publishing approval', statement: 'Approve before publishing', targetRef: 'wiki:approval', evidenceIds,
          applicability: { project: scope, environments: [], versions: ['approval-v1'], preconditions: [], exclusions: [],
            invalidationConditions: ['Approval policy changes'] },
          payload: { ...payload, steps: payload.steps.map(step => ({ ...step, evidenceIds })) },
        }] },
      } };
    } finally { store.close(); }
  });
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  await runtime.activate({ manifest: { id: 'retrospective.local-contract', version: '1.0.0', apiVersion: 1,
    trusted: true, provides: ['agent.provider', 'verification.provider'] }, activate: context => {
    context.registerAgentProvider('claude-code', new ClaudeCodeProvider());
    context.registerVerificationProvider(provider.id, provider);
  } });
  await runtime.activate(createLearningPlugin({ homeDir, config: { enabled: true, dailyCalls: 1,
    validation: { configurationFile: fixture.validationConfigurationFile },
    knowledge: { wikiScript: fixture.wikiScript, grants: [fixture.authorizationFile] } } }));
  const unrelated = await runtime.dispatchSystemAction('learning.capture', { scope, runId: 'unrelated-run' }) as { requestKeys: string[] };
  const templatePath = join(fixture.root, 'retrospective.yml');
  writeFileSync(templatePath, `name: local-retrospective\nversion: 1\npurpose: learning\nsteps:\n  - id: prepare\n    kind: system\n    action: learning.retrospective\n    input:\n      scope: ${scope}\n      runId: source-run\n      kind: process\n      checkerId: ${identity.checkerId}\n`);
  const template = await new TemplateLoader().load(templatePath);
  const unexpected = () => { throw new Error('Unexpected external workflow action'); };
  const actions = new SystemActionExecutor({ plugins: runtime, publishChange: unexpected, queueQA: unexpected });
  const executor = new PlanExecutor({ systemActions: runtime.listSystemActions(), executeAgent: unexpected,
    executeSystem: async step => {
      const startedAt = new Date().toISOString();
      const output = await actions.execute(step.action, { iid: 42, worktreePath: fixture.root, branch: 'feat/local-test',
        targetBranch: 'main', step, input: step.input });
      return { stepId: step.id, status: 'completed', output, startedAt, completedAt: new Date().toISOString() };
    } });
  return { fixture, runtime, scope, file, homeDir, provider, transcriptPath, templatePath, events, verify, unrelatedKey: unrelated.requestKeys[0]!,
    execute: () => executor.execute(template) };
}

function publicRunner(input: Awaited<ReturnType<typeof setup>>) {
  const git = (...args: string[]) => execFileSync('git', ['-C', input.fixture.root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  const forbidden = vi.fn(() => { throw new Error('Execution-only dependency called by learning workflow'); });
  const runner = new WorkflowRunner({
    backlog: { get: forbidden, claim: forbidden, transition: forbidden, release: forbidden, heartbeat: forbidden },
    branches: { createBranch: forbidden, commit: forbidden, preparePush: forbidden, push: forbidden, cleanup: forbidden },
    changes: { create: forbidden, findForBacklog: forbidden },
  } as unknown as ProviderBundle, {
    plugins: input.runtime, observer: createPluginRunObserver(input.runtime, input.events.root),
    agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution: forbidden },
    sandboxProvider: { name: 'local', create: forbidden },
    runtimeManager: { start: forbidden, heartbeat: forbidden, finish: forbidden, writeDiagnostics: forbidden },
    tmux: { hasSession: forbidden, closeSession: forbidden, killSession: forbidden },
    watchdog: { arm: forbidden, disarm: vi.fn() }, prepareRuntime: forbidden,
    multiRepositoryPreparer: { prepare: forbidden },
  } as unknown as RunnerDependencies);
  const history = async (runId: string) => {
    const result: RunEvent[] = [];
    for await (const event of input.events.read(runId)) result.push(event);
    return result;
  };
  return { forbidden, history, git, baseline,
    execute: (runId = 'learning-public-run') => runner.run({ backlogId: `${input.scope}#42`, session: 'local-retrospective',
      repoRoot: input.fixture.root, targetBranch: 'main', template: input.templatePath, hardTimeoutMs: 10_000,
      observationRunId: runId, observationWorkItemId: `${input.scope}#42`, auditRequired: true }) };
}

describe('local retrospective with real intake, SQLite, worker, validation, guards and Wiki preview; synthetic analysis and domain oracle', () => {
  it('rejects a different source work item in the same project before capture or analysis', async () => {
    const input = await setup();
    vi.stubEnv('HOME', input.homeDir);
    vi.stubEnv('AFK_EVENT_STORE_DIR', input.events.root);
    vi.stubEnv('AFK_LOG_DIR', join(input.homeDir, 'logs'));
    vi.spyOn(process, 'cwd').mockReturnValue(input.fixture.root);
    const sourceBefore = readFileSync(input.events.pathFor('source-run'), 'utf8');
    const result = await runSuccessReviewWorkflow({ plugins: input.runtime, backlogId: `${input.scope}#43`,
      sourceRunId: 'source-run', checkerId: 'process-checker', hardTimeoutMs: 10_000 });
    expect(result.success).toBe(false);
    expect(result.steps?.review).toMatchObject({ status: 'failed' });
    expect(result.steps?.review?.output).toBeUndefined();
    expect(analysis).not.toHaveBeenCalled();
    expect(input.verify).not.toHaveBeenCalled();
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listRequests().map(request => request.key)).toEqual([input.unrelatedKey]);
      expect(store.listCandidates()).toEqual([]);
      expect(store.listPublications()).toEqual([]);
    } finally { store.close(); }
    expect(readFileSync(input.events.pathFor('source-run'), 'utf8')).toBe(sourceBefore);
  });

  it('runs the product success-review template and returns exact previews across a runtime restart', async () => {
    const input = await setup();
    vi.stubEnv('HOME', input.homeDir);
    vi.stubEnv('AFK_EVENT_STORE_DIR', input.events.root);
    vi.stubEnv('AFK_LOG_DIR', join(input.homeDir, 'logs'));
    vi.spyOn(process, 'cwd').mockReturnValue(input.fixture.root);
    const sourceBefore = readFileSync(input.events.pathFor('source-run'), 'utf8');
    const options = { plugins: input.runtime, backlogId: `${input.scope}#42`, sourceRunId: 'source-run',
      checkerId: 'process-checker', hardTimeoutMs: 10_000 };
    const first = await runSuccessReviewWorkflow(options);
    expect(first.success).toBe(true);
    const output = first.steps?.review?.output;
    expect(output).toMatchObject({ scope: input.scope, runId: 'source-run', requestKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      prepared: [expect.objectContaining({ candidateId: expect.stringMatching(/^[a-f0-9]{64}$/), validatedVersion: 2,
        publication: expect.objectContaining({ phase: 'prepared' }) })] });
    await input.runtime.close();
    const restarted = new PluginRuntime();
    runtimes.push(restarted);
    await restarted.activate({ manifest: { id: 'retrospective.local-contract', version: '1.0.0', apiVersion: 1,
      trusted: true, provides: ['agent.provider', 'verification.provider'] }, activate: context => {
      context.registerAgentProvider('claude-code', new ClaudeCodeProvider());
      context.registerVerificationProvider(input.provider.id, input.provider);
    } });
    await restarted.activate(createLearningPlugin({ homeDir: input.homeDir, config: { enabled: true, dailyCalls: 1,
      validation: { configurationFile: input.fixture.validationConfigurationFile },
      knowledge: { wikiScript: input.fixture.wikiScript, grants: [input.fixture.authorizationFile] } } }));
    const replay = await runSuccessReviewWorkflow({ ...options, plugins: restarted });
    expect(replay.success).toBe(true);
    expect(replay.steps?.review?.output).toEqual(output);
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.verify).toHaveBeenCalledTimes(1);
    expect(readFileSync(input.events.pathFor('source-run'), 'utf8')).toBe(sourceBefore);
    const runs = (await input.events.listRuns()).filter(runId => !['source-run', 'unrelated-run'].includes(runId));
    expect(runs).toHaveLength(2);
    for (const runId of runs) {
      expect(await input.events.verify(runId)).toMatchObject({ valid: true });
      const events: RunEvent[] = [];
      for await (const event of input.events.read(runId)) events.push(event);
      expect(events.find(event => event.type === 'workflow.recorded')?.data)
        .toMatchObject({ name: 'success-review-preview' });
      expect(events.at(-1)?.data).toEqual({ kind: 'run.finished', outcome: 'succeeded' });
    }
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listPublications()).toEqual([expect.objectContaining({ phase: 'prepared' })]);
      expect(store.listCandidates()).toEqual([expect.objectContaining({ state: 'validated', version: 2 })]);
      expect(store.listPendingRequests().map(request => request.key)).toEqual([input.unrelatedKey]);
    } finally { store.close(); }
    expect(existsSync(join(input.fixture.vault, '知识/Approval.md'))).toBe(false);
  });

  it('fails the product review without a preview when the domain observation disagrees', async () => {
    const input = await setup(false);
    vi.stubEnv('HOME', input.homeDir);
    vi.stubEnv('AFK_EVENT_STORE_DIR', input.events.root);
    vi.stubEnv('AFK_LOG_DIR', join(input.homeDir, 'logs'));
    vi.spyOn(process, 'cwd').mockReturnValue(input.fixture.root);
    const result = await runSuccessReviewWorkflow({ plugins: input.runtime, backlogId: `${input.scope}#42`,
      sourceRunId: 'source-run', checkerId: 'process-checker', hardTimeoutMs: 10_000 });
    expect(result.success).toBe(false);
    expect(result.steps?.review).toMatchObject({ status: 'failed' });
    expect(result.steps?.review?.output).toBeUndefined();
    const store = new CandidateStore({ file: input.file });
    try { expect(store.listPublications()).toEqual([]); } finally { store.close(); }
  });

  it.each(['direct', 'envelope'].flatMap(form => ['source-run', ' source-run '].map(sourceRunId => ({ form, sourceRunId }))))(
    'rejects reuse of source identity "$sourceRunId" with $form input before appending audit or consuming its request', async ({ form, sourceRunId }) => {
    const input = await setup();
    const template = await new TemplateLoader().load(input.templatePath);
    const step = template.steps[0]!;
    step.input = { ...step.input as { runId: string }, runId: sourceRunId };
    if (form === 'envelope') {
      step.input = { iid: 42, worktreePath: input.fixture.root, branch: 'main', targetBranch: 'main',
        step: { id: step.id, kind: step.kind, action: step.action }, input: step.input };
    }
    writeFileSync(input.templatePath, JSON.stringify(template));
    const run = publicRunner(input);
    const sourceHistory = await run.history('source-run');
    await expect(run.execute('source-run')).rejects.toThrow(/source.*run|distinct/i);
    expect(await run.history('source-run')).toEqual(sourceHistory);
    expect(analysis).not.toHaveBeenCalled();
    expect(input.verify).not.toHaveBeenCalled();
    expect(run.forbidden).not.toHaveBeenCalled();
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listRequests()).toHaveLength(1);
      expect(store.listCandidates()).toEqual([]);
      expect(store.listPublications()).toEqual([]);
    } finally { store.close(); }
  });

  it.each(['direct', 'envelope'])('preserves trimmed source identity for ordinary %s action dispatch', async form => {
    const input = await setup();
    const request = { scope: input.scope, runId: ' source-run ' };
    const payload = form === 'direct' ? request : { iid: 42, worktreePath: input.fixture.root,
      branch: 'main', targetBranch: 'main', step: { id: 'capture', kind: 'system', action: 'learning.capture' }, input: request };
    const run = publicRunner(input);
    const sourceHistory = await run.history('source-run');
    const result = await input.runtime.dispatchSystemAction('learning.capture', payload) as {
      checkedSources: { runId: string }[]; requestKeys: string[] };
    expect(result.checkedSources).toEqual([expect.objectContaining({ runId: 'source-run' })]);
    expect(result.requestKeys).toHaveLength(1);
    expect(await run.history('source-run')).toEqual(sourceHistory);
    expect(analysis).not.toHaveBeenCalled();
    expect(input.verify).not.toHaveBeenCalled();
  });

  it('rejects duplicate step identities before starting audit, hooks or real actions', async () => {
    const input = await setup();
    writeFileSync(input.templatePath, JSON.stringify({ name: 'duplicate-learning', version: 1, purpose: 'learning', steps: [
      { id: 'same', kind: 'system', action: 'learning.context', input: { scope: 'not-a-project' } },
      { id: 'same', kind: 'system', action: 'learning.settings', input: {} },
    ] }));
    const run = publicRunner(input);
    await expect(run.execute()).rejects.toThrow(/duplicate.*same/i);
    expect(await run.history('learning-public-run')).toEqual([]);
    expect(analysis).not.toHaveBeenCalled();
    expect(input.verify).not.toHaveBeenCalled();
    expect(run.forbidden).not.toHaveBeenCalled();
  });

  it('prepares and replays through the public runner without changing source runs, claiming work or recursively collecting learning events', async () => {
    const input = await setup();
    const run = publicRunner(input);
    const sourceHistory = await run.history('source-run');
    const unrelatedHistory = await run.history('unrelated-run');
    const gitStatus = run.git('status', '--porcelain');
    await expect(run.execute()).resolves.toMatchObject({ success: true,
      steps: { prepare: { status: 'completed', output: { prepared: [expect.objectContaining({ validatedVersion: 2 })] } } } });
    const events = await run.history('learning-public-run');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => event.context.purpose === 'learning')).toBe(true);
    expect(events.filter(event => event.type === 'run.finished').map(event => event.data))
      .toEqual([{ kind: 'run.finished', outcome: 'succeeded' }]);
    expect(events.filter(event => event.type === 'effect.completed').map(event => event.data))
      .toEqual([expect.objectContaining({ effectKind: 'learning.retrospective', outcome: 'succeeded' })]);
    expect(events.map(event => event.type)).not.toContain('implementation.completed');
    expect(events.map(event => event.type)).not.toContain('qa.passed');
    expect(await input.events.verify('learning-public-run')).toMatchObject({ valid: true });
    expect(await run.history('source-run')).toEqual(sourceHistory);
    expect(await run.history('unrelated-run')).toEqual(unrelatedHistory);
    await expect(run.execute('learning-public-replay')).resolves.toMatchObject({ success: true,
      steps: { prepare: { status: 'completed', output: { prepared: [expect.objectContaining({ validatedVersion: 2 })] } } } });
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.verify).toHaveBeenCalledTimes(1);
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listCandidates()).toEqual([expect.objectContaining({ state: 'validated', version: 2 })]);
      expect(store.listPublications()).toEqual([expect.objectContaining({ phase: 'prepared' })]);
      expect(store.listRequests()).toHaveLength(2);
      expect(store.listPendingRequests().map(request => request.key)).toEqual([input.unrelatedKey]);
    } finally { store.close(); }
    expect(run.forbidden).not.toHaveBeenCalled();
    expect(run.git('rev-parse', 'HEAD')).toBe(run.baseline);
    expect(run.git('status', '--porcelain')).toBe(gitStatus);
    expect(run.git('branch', '--format=%(refname:short)')).toBe('main');
    expect(run.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(existsSync(join(input.fixture.vault, '知识/Approval.md'))).toBe(false);
  });

  it('records a failed public learning run for a contrary domain observation without preparing a publication', async () => {
    const input = await setup(false);
    const run = publicRunner(input);
    await expect(run.execute()).resolves.toMatchObject({ success: false, steps: { prepare: { status: 'failed' } } });
    const events = await run.history('learning-public-run');
    expect(events.filter(event => event.type === 'run.finished').map(event => event.data))
      .toEqual([{ kind: 'run.finished', outcome: 'failed' }]);
    expect(events.filter(event => event.type === 'effect.completed').map(event => event.data))
      .toEqual([expect.objectContaining({ effectKind: 'learning.retrospective', outcome: 'failed',
        summary: expect.stringContaining('learning_validation_') })]);
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listCandidates()).toEqual([expect.objectContaining({ state: 'candidate', version: 1 })]);
      expect(store.listPublications()).toEqual([]);
      expect(store.listRequests()).toHaveLength(2);
      expect(store.listPendingRequests().map(request => request.key)).toEqual([input.unrelatedKey]);
    } finally { store.close(); }
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.verify).toHaveBeenCalledTimes(1);
    expect(run.forbidden).not.toHaveBeenCalled();
    expect(run.git('rev-parse', 'HEAD')).toBe(run.baseline);
    expect(existsSync(join(input.fixture.vault, '知识/Approval.md'))).toBe(false);
  });

  it('prepares one exact request, replays without publishing, and rejects revoked validation authority', async () => {
    const input = await setup();
    const result = await input.execute();
    const output = result.prepare!.output as { requestKey: string; prepared: { candidateId: string; validatedVersion: number }[] };
    expect(output.prepared).toEqual([expect.objectContaining({ validatedVersion: 2 })]);
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.verify).toHaveBeenCalledTimes(1);
    const state = await input.runtime.dispatchSystemAction('learning.request', { scope: input.scope, requestKey: output.requestKey }) as LearningRequestState;
    expect(state.job.status).toBe('processed');
    expect(state.processing!.candidateIds).toEqual(output.prepared.map(entry => entry.candidateId));
    expect(state.candidates).toEqual([expect.objectContaining({ state: 'validated', version: 2 })]);
    expect(await input.runtime.dispatchSystemAction('learning.request', { scope: input.scope, requestKey: input.unrelatedKey }))
      .toMatchObject({ job: { status: 'pending', attempts: [] }, candidates: [] });
    expect((await input.execute()).prepare!.output).toEqual(output);
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.verify).toHaveBeenCalledTimes(1);
    const store = new CandidateStore({ file: input.file });
    try { expect(store.listPublications().map(entry => entry.phase)).toEqual(['prepared']); }
    finally { store.close(); }
    expect(existsSync(join(input.fixture.vault, '知识/Approval.md'))).toBe(false);
    const grant = JSON.parse(readFileSync(input.fixture.validationAuthorizationFile, 'utf8'));
    writeFileSync(input.fixture.validationAuthorizationFile, JSON.stringify({ ...grant, revoked: true }));
    await expect(input.execute()).rejects.toThrow();
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(existsSync(join(input.fixture.vault, '知识/Approval.md'))).toBe(false);
  });

  it('uses the same trusted home for explicit publication, context reads and withdrawal after transcript drift', async () => {
    const input = await setup();
    const result = await input.execute();
    const output = result.prepare!.output as { prepared: { publication: { key: string } }[] };
    const key = output.prepared[0]!.publication.key;
    expect(await input.runtime.dispatchSystemAction('learning.knowledge.publish', { scope: input.scope, key }))
      .toMatchObject({ publication: { key, phase: 'committed' } });
    const context = input.runtime.getContextProvider('context.knowledge')!;
    const query = { scope: input.scope, prompt: 'approval', applicability: { version: 'approval-v1' },
      target: { project: input.scope, conditions: { 'Approval policy changes': false } } };
    expect(await context.gather({ ...query, target: undefined })).toEqual([]);
    expect(await context.gather(query)).toEqual([expect.objectContaining({ content: expect.stringContaining('Approve before publishing') })]);
    writeFileSync(input.transcriptPath, JSON.stringify({ type: 'user', message: { content: 'Approval policy changed.' } }) + '\n');
    expect(await context.gather(query)).toEqual([]);
    expect(await input.runtime.dispatchSystemAction('learning.knowledge.reconcile', { scope: input.scope }))
      .toMatchObject({ blocked: [], results: [{ publication: { key }, withdrawal: { status: 'withdrawn' } }] });
    expect(readFileSync(join(input.fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
    expect(analysis).toHaveBeenCalledTimes(1);
  });

  it('rejects a contrary domain observation despite provider passed=true, without preparing or publishing', async () => {
    const input = await setup(false);
    await expect(input.execute()).rejects.toThrow('learning_validation_');
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(input.verify).toHaveBeenCalledTimes(1);
    const store = new CandidateStore({ file: input.file });
    try {
      expect(store.listCandidates()).toEqual([expect.objectContaining({ state: 'candidate', version: 1 })]);
      expect(store.listPublications()).toEqual([]);
    } finally { store.close(); }
    expect(existsSync(join(input.fixture.vault, '知识/Approval.md'))).toBe(false);
  });
});
