import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@afk/core';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { WorkflowRunner } from '../workflow-engine.js';
import { createPluginRunObserver } from '../plugins/observability.js';
import { createLearningPlugin } from '../plugins/learning.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { LearningReviewIncompleteError } from '../learning/contracts.js';
import type { LearningValidationResult } from '../learning/validation.js';
import { runOptimizationReviewWorkflow, runRepairReviewWorkflow, runSuccessReviewWorkflow, runWorkflowCli } from './run-cmd.js';

const managed = vi.hoisted(() => ({ resolve: vi.fn(), execute: vi.fn(), template: undefined as string | undefined }));
vi.mock('./run-request.js', async importOriginal => ({
  ...await importOriginal<typeof import('./run-request.js')>(),
  resolveWorkflowRunRequest: managed.resolve,
}));
vi.mock('./execute-work-item.js', () => ({ executeWorkItem: managed.execute }));
vi.mock('../../infrastructure/config/manager.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../infrastructure/config/manager.js')>(),
  getWorkflowConfig: () => ({ agentDefault: 'unavailable-agent', workflowHardTimeout: 10000, template: managed.template }),
}));

const roots: string[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  managed.template = undefined;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'learning-cli-route-'));
  roots.push(root);
  vi.stubEnv('AFK_EVENT_STORE_DIR', join(root, 'events'));
  vi.stubEnv('AFK_LOG_DIR', join(root, 'logs'));
  const plugins = new PluginRuntime();
  runtimes.push(plugins);
  await plugins.activate(createLearningPlugin({ homeDir: root, config: {} }));
  const template = join(root, 'settings.yml');
  await writeFile(template, JSON.stringify({ name: 'local-settings', version: 1, purpose: 'learning',
    steps: [{ id: 'settings', kind: 'system', action: 'learning.settings', input: {} }] }));
  managed.resolve.mockRejectedValue(new Error('managed repository resolution must not run'));
  managed.execute.mockRejectedValue(new Error('managed execution and QA must not run'));
  return { root, plugins, template, events: new JsonlEventStore({ root: join(root, 'events') }) };
}

describe('runWorkflowCli learning route', () => {
  it('runs a real local settings template without managed repository resolution or QA', async () => {
    const test = await fixture();
    const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction');
    await expect(runWorkflowCli({ backlogId: 'github:acme/api#42', plugins: test.plugins,
      template: test.template, hardTimeoutMs: 10000 })).resolves.toMatchObject({ success: true,
        steps: { settings: { stepId: 'settings', status: 'completed', output: expect.any(Object) } } });
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('learning.settings', expect.anything(), expect.anything());
    const runs = await test.events.listRuns();
    expect(runs).toHaveLength(1);
    const events: RunEvent[] = [];
    for await (const event of test.events.read(runs[0]!)) events.push(event);
    expect(events.length).toBeGreaterThan(2);
    expect(events.every(event => event.context.purpose === 'learning'
      && event.context.workItemId === 'github:acme/api#42')).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ kind: 'run.finished', outcome: 'succeeded' });
    expect(await test.events.verify(runs[0]!)).toMatchObject({ valid: true });
  });

  it('persists and verifies JSONL audit for a long canonical GitLab identity through the learning CLI', async () => {
    const test = await fixture();
    const workItemId = `gitlab:gitlab.example.com/${'engineering-group/'.repeat(12)}knowledge-repository#42`;
    expect(parseWorkItemId(workItemId).id).toBe(workItemId);
    const session = 'long-project-learning';
    await expect(runWorkflowCli({ backlogId: workItemId, session, plugins: test.plugins,
      template: test.template, hardTimeoutMs: 10000 })).resolves.toMatchObject({ success: true,
        steps: { settings: { status: 'completed' } } });
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
    const runs = await test.events.listRuns();
    expect(runs).toHaveLength(1);
    const runId = runs[0]!;
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const jsonl = await readFile(test.events.pathFor(runId), 'utf8');
    expect(jsonl.endsWith('\n')).toBe(true);
    const events = jsonl.trimEnd().split('\n').map(line => JSON.parse(line) as RunEvent);
    expect(events.length).toBeGreaterThan(2);
    expect(events.every(event => event.context.runId === runId && event.context.traceId === runId
      && event.context.workItemId === workItemId && event.context.purpose === 'learning'
      && event.context.actor.id === session)).toBe(true);
    expect(events[0]?.data).toMatchObject({ kind: 'run.requested', run: { id: runId, workItemId } });
    expect(events.some(event => event.data.kind === 'effect.completed' && event.data.outcome === 'succeeded')).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ kind: 'run.finished', outcome: 'succeeded' });
    expect(await test.events.verify(runId)).toEqual({ valid: true, lastSequence: events.length,
      lastHash: events.at(-1)!.integrity.hash });
  });

  it('rejects an execution manifest before managed resolution or learning effects', async () => {
    const test = await fixture();
    const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction');
    await expect(runWorkflowCli({ backlogId: 'github:acme/api#42', plugins: test.plugins,
      template: test.template, executionManifestPath: join(test.root, 'manifest.json') }))
      .rejects.toThrow('learning templates cannot use an execution manifest');
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await test.events.listRuns()).toEqual([]);
  });

  it('selects a configured learning template without requiring an installed execution agent', async () => {
    const test = await fixture();
    managed.template = test.template;
    await expect(runWorkflowCli({ backlogId: 'github:acme/api#42', plugins: test.plugins })).resolves.toMatchObject({ success: true,
      steps: { settings: { status: 'completed' } } });
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
  });

  it('executes the classified template snapshot even if its file changes before execution', async () => {
    const test = await fixture();
    const load = TemplateLoader.prototype.load;
    const loading = vi.spyOn(TemplateLoader.prototype, 'load').mockImplementation(async function(this: TemplateLoader, name, options) {
      const template = await load.call(this, name, options);
      await writeFile(test.template, JSON.stringify({ name: 'changed-execution', version: 1,
        purpose: 'execution', steps: [{ id: 'publish', kind: 'system', action: 'publish-change' }] }));
      return template;
    });
    await expect(runWorkflowCli({ backlogId: 'github:acme/api#42', plugins: test.plugins,
      template: test.template })).resolves.toMatchObject({ success: true, steps: { settings: { status: 'completed' } } });
    expect(loading).toHaveBeenCalledOnce();
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
  });

  it.each((['skill', 'tool'] as const).flatMap(kind => ['github:acme/api#42',
    `gitlab:gitlab.example.com/${'engineering-group/'.repeat(12)}knowledge-repository#42`].map(workItemId => ({ kind, workItemId }))))(
    'routes $kind validation for the exact canonical $workItemId through the learning review step', async ({ kind, workItemId }) => {
      const test = await fixture();
      const identity = parseWorkItemId(workItemId);
      const scope = `${identity.platform}:${identity.projectKey}`;
      const validation = { status: 'validated', candidateId: 'b'.repeat(64), candidateVersion: 1, validatedVersion: 2,
        executionId: 'validation-run', receiptDigest: 'c'.repeat(64) } satisfies LearningValidationResult;
      const output = { scope, runId: 'source-run', requestKey: 'a'.repeat(64),
        processing: { requestKey: 'a'.repeat(64), outputDigest: 'd'.repeat(64), candidateIds: [validation.candidateId], warnings: [] },
        validated: [validation] };
      const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction').mockResolvedValue(output);
      const run = vi.spyOn(WorkflowRunner.prototype, 'run');
      const result = await runOptimizationReviewWorkflow({ kind, plugins: test.plugins, backlogId: workItemId,
        sourceRunId: ' source-run ', checkerId: ' optimization-policy-v1 ', session: 'optimization-review', hardTimeoutMs: 10000 });
      expect(result).toMatchObject({ success: true, steps: { review: { stepId: 'review', status: 'completed' } } });
      expect(result.steps?.review?.output).toEqual(output);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith('learning.retrospective', { scope, workItemId, runId: 'source-run', kind,
        checkerId: 'optimization-policy-v1' }, expect.anything());
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'learning', backlogId: workItemId,
        workItemId, session: 'optimization-review', hardTimeoutMs: 10000 }));
      expect(managed.resolve).not.toHaveBeenCalled();
      expect(managed.execute).not.toHaveBeenCalled();
      const runs = await test.events.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).not.toBe('source-run');
      const events = (await readFile(test.events.pathFor(runs[0]!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as RunEvent);
      expect(events.every(event => event.context.purpose === 'learning' && event.context.workItemId === workItemId)).toBe(true);
      expect(events.some(event => event.data.kind === 'workflow.recorded' && event.data.name === `${kind}-optimization-validation`)).toBe(true);
    });

  describe.each(['success', 'repair', 'skill', 'tool'] as const)('%s review scope boundaries', kind => {
    const review = (options: Parameters<typeof runSuccessReviewWorkflow>[0]) => kind === 'success'
      ? runSuccessReviewWorkflow(options) : kind === 'repair' ? runRepairReviewWorkflow(options)
        : runOptimizationReviewWorkflow({ ...options, kind });
    const scopes = [
      { encoding: 'ASCII', scope: `github:acme/${'a'.repeat(500)}` },
      { encoding: 'UTF-8', scope: `github:acme/${'界'.repeat(166)}aa` },
    ];

    it.each(scopes)('rejects a 513-byte $encoding scope before running or dispatching', async ({ scope }) => {
      const test = await fixture();
      const invalidScope = `${scope}a`;
      const workItemId = `${invalidScope}#42`;
      expect(Buffer.byteLength(invalidScope, 'utf8')).toBe(513);
      expect(parseWorkItemId(workItemId).id).toBe(workItemId);
      const run = vi.spyOn(WorkflowRunner.prototype, 'run');
      const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction');
      await expect(review({ plugins: test.plugins, backlogId: workItemId,
        sourceRunId: 'source-run', checkerId: 'review-policy-v1' })).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(managed.resolve).not.toHaveBeenCalled();
      expect(managed.execute).not.toHaveBeenCalled();
      expect(await test.events.listRuns()).toEqual([]);
    });

    it.each(scopes)('dispatches the exact canonical 512-byte $encoding scope', async ({ scope }) => {
      const test = await fixture();
      const workItemId = `${scope}#42`;
      expect(Buffer.byteLength(scope, 'utf8')).toBe(512);
      expect(parseWorkItemId(workItemId).id).toBe(workItemId);
      const output = { scope, runId: 'source-run' };
      const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction').mockResolvedValue(output);
      const result = await review({ plugins: test.plugins, backlogId: workItemId,
        sourceRunId: 'source-run', checkerId: 'review-policy-v1', hardTimeoutMs: 10000 });
      expect(result.success).toBe(true);
      expect(result.steps?.review?.output).toEqual(output);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith('learning.retrospective', { scope, workItemId, runId: 'source-run',
        kind: kind === 'success' ? 'process' : kind === 'repair' ? 'lesson' : kind,
        checkerId: 'review-policy-v1', ...(kind === 'repair' ? { repair: true } : {}) }, expect.anything());
      expect(managed.resolve).not.toHaveBeenCalled();
      expect(managed.execute).not.toHaveBeenCalled();
    });
  });

  it.each(['skill', 'tool'] as const)('returns a failed review without a validation receipt when the %s action fails', async kind => {
    const test = await fixture();
    const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction').mockRejectedValue(new Error('validation_not_configured'));
    const result = await runOptimizationReviewWorkflow({ kind, plugins: test.plugins, backlogId: 'github:acme/api#42',
      sourceRunId: 'source-run', checkerId: 'optimization-policy-v1' });
    expect(result).toMatchObject({ success: false, steps: { review: { status: 'failed' } } });
    expect(result.steps?.review?.output).toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
  });

  it.each(['skill', 'tool'] as const)('preserves the exact incomplete error through the real %s optimization review runner', async kind => {
    const test = await fixture();
    const workItemId = 'github:acme/api#42';
    const receipt = { status: 'validated', candidateId: 'b'.repeat(64), candidateVersion: 7, validatedVersion: 8,
      executionId: 'optimization-validation-run', receiptDigest: 'c'.repeat(64) } satisfies LearningValidationResult;
    const cause = new Error('private-validator-detail');
    const incomplete = new LearningReviewIncompleteError({ status: 'incomplete', scope: 'github:acme/api',
      runId: 'source-run', requestKey: 'a'.repeat(64), validated: [receipt],
      interruptedCandidateId: 'd'.repeat(64), reason: 'validation_failed' }, { cause });
    const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction').mockRejectedValue(incomplete);
    const run = vi.spyOn(WorkflowRunner.prototype, 'run');
    await expect(runOptimizationReviewWorkflow({ kind, plugins: test.plugins, backlogId: workItemId,
      sourceRunId: 'source-run', checkerId: 'optimization-policy-v1', session: 'incomplete-optimization-review',
      hardTimeoutMs: 10000 })).rejects.toBe(incomplete);
    expect(incomplete.output).toEqual({ status: 'incomplete', scope: 'github:acme/api', runId: 'source-run',
      requestKey: 'a'.repeat(64), validated: [receipt], interruptedCandidateId: 'd'.repeat(64), reason: 'validation_failed' });
    expect(incomplete.cause).toBe(cause);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith('learning.retrospective', { scope: 'github:acme/api', workItemId,
      runId: 'source-run', kind, checkerId: 'optimization-policy-v1' }, expect.anything());
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'learning', backlogId: workItemId,
      workItemId, session: 'incomplete-optimization-review', hardTimeoutMs: 10000 }));
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
    const runs = await test.events.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toBe('source-run');
    const events = (await readFile(test.events.pathFor(runs[0]!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as RunEvent);
    expect(events.some(event => event.data.kind === 'workflow.recorded' && event.data.name === `${kind}-optimization-validation`)).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ kind: 'run.finished', outcome: 'failed' });
  });

  it.each([
    { targetBranch: 'feature' }, { baseBranch: 'main' }, { branchStrategy: { type: 'named' as const, branch: 'feature' } },
    { sandboxProvider: 'docker' }, { agentProvider: 'claude-code' }, { agentRuntime: { kind: 'default' as const } },
    { agentRuntimeOverrides: { transport: 'exec' as const } }, { executionMode: 'batch' as const },
  ])('rejects inapplicable execution options %j before learning effects', async options => {
    const test = await fixture();
    const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction');
    await expect(runWorkflowCli({ backlogId: 'github:acme/api#42', plugins: test.plugins,
      template: test.template, ...options })).rejects.toThrow('learning templates cannot use execution');
    expect(dispatch).not.toHaveBeenCalled();
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(await test.events.listRuns()).toEqual([]);
  });

  it('requires a canonical source work item instead of resolving a tracker', async () => {
    const test = await fixture();
    await expect(runWorkflowCli({ backlogId: '42', plugins: test.plugins, template: test.template })).rejects.toThrow();
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(await test.events.listRuns()).toEqual([]);
  });

  it('keeps repeated learning invocations in distinct audit runs', async () => {
    const test = await fixture();
    for (let invocation = 0; invocation < 2; invocation++) {
      await expect(runWorkflowCli({ backlogId: 'github:acme/api#42', plugins: test.plugins,
        template: test.template, session: 'same-session' })).resolves.toMatchObject({ success: true,
          steps: { settings: { status: 'completed' } } });
    }
    expect(await test.events.listRuns()).toHaveLength(2);
  });

  it('refuses an execution template without managed providers before audit or actions', async () => {
    const test = await fixture();
    const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction');
    const runner = new WorkflowRunner(undefined, { config: getWorkflowConfig(), plugins: test.plugins,
      observer: createPluginRunObserver(test.plugins), template: { name: 'requires-execution', version: 1,
        purpose: 'execution', steps: [{ id: 'settings', kind: 'system', action: 'learning.settings', input: {} }] } });
    await expect(runner.run({ backlogId: 'github:acme/api#42', session: 'missing-providers', targetBranch: 'main' }))
      .rejects.toThrow('execution workflows require managed providers');
    expect(dispatch).not.toHaveBeenCalled();
    expect(await test.events.listRuns()).toEqual([]);
  });

  it.each([
    { backlogId: '42' }, { sourceRunId: '' }, { sourceRunId: 'source\nrun' },
    { checkerId: '' }, { checkerId: 'checker\0private' },
  ])('rejects invalid product review identities before audit or actions: %j', async invalid => {
    const test = await fixture();
    const dispatch = vi.spyOn(test.plugins, 'dispatchSystemAction');
    const options = { plugins: test.plugins, backlogId: 'github:acme/api#42',
      sourceRunId: 'source-run', checkerId: 'process-checker', ...invalid };
    for (const review of [runSuccessReviewWorkflow, runRepairReviewWorkflow]) {
      await expect(review(options)).rejects.toThrow();
    }
    for (const kind of ['skill', 'tool'] as const) {
      await expect(runOptimizationReviewWorkflow({ ...options, kind })).rejects.toThrow();
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(managed.resolve).not.toHaveBeenCalled();
    expect(managed.execute).not.toHaveBeenCalled();
    expect(await test.events.listRuns()).toEqual([]);
  });
});
