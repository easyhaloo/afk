import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationContext, RunEventData } from '@afk/core';
import type { BacklogItem } from '../domain/backlog/index.js';
import { parseWorkItemId } from '../domain/work-item/identity.js';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import type { RunObserver } from '../observability/run-observer.js';
import { AuditPersistenceError, WorkflowRunner, type RunnerOptions } from './workflow-engine.js';
import { LearningReviewIncompleteError } from './learning/contracts.js';
import { createLearningPlugin } from './plugins/learning.js';
import { PluginRuntime, type PluginSystemActionOptions } from './plugins/runtime.js';
import type { LifecycleContext } from './workflows/lifecycle.js';

const roots: string[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('WorkflowRunner learning action input', () => {
  it('executes strict learning inputs while preserving the envelope of other plugin actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'learning-workflow-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'baseline']);
    const scope = 'github:acme/api';
    const workItemId = parseWorkItemId(`${scope}#42`).id;
    const config = { executionContexts: [{ target: { project: scope, conditions: { approved: true } } }] };
    const plugins = new PluginRuntime();
    runtimes.push(plugins);
    await plugins.activate(createLearningPlugin({ homeDir: root, config }));
    const inspectEnvelope = vi.fn(async () => ({ inspected: true }));
    await plugins.activate({ id: 'workflow.learning-test', version: '1.0.0', setup(context) {
      context.registerSystemAction('test.inspect-envelope', inspectEnvelope);
      context.registerWorkflowTemplate({ name: 'learning-input-test', version: 1, steps: [
        { id: 'settings', kind: 'system', action: 'learning.settings', input: {} },
        { id: 'context', kind: 'system', action: 'learning.context', input: { scope }, dependsOn: ['settings'] },
        { id: 'jobs', kind: 'system', action: 'learning.jobs', input: { scope }, dependsOn: ['context'] },
        { id: 'candidates', kind: 'system', action: 'learning.candidates', input: { scope }, dependsOn: ['jobs'] },
        { id: 'inspect', kind: 'system', action: 'test.inspect-envelope', input: { scope }, dependsOn: ['candidates'] },
      ] });
    } });
    const dispatch = vi.spyOn(plugins, 'dispatchSystemAction');
    const record = vi.fn(async () => {});
    const createExecution = vi.fn(async () => { throw new Error('unexpected agent execution'); });
    const providers = {
      backlog: { transition: vi.fn(async () => {}) },
      branches: { createBranch: vi.fn(async () => ({ branchName: 'feat/learning', worktreePath: root })) },
    } as unknown as ProviderBundle;
    const workflow = new WorkflowRunner(providers, {
      plugins,
      observer: { record } as unknown as RunObserver,
      agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution },
      sandboxProvider: { name: 'local', create: vi.fn(async () => ({ id: 'learning-sandbox', worktreePath: root, close: async () => {} })) } as never,
      watchdog: { arm: vi.fn(), disarm: vi.fn() } as never,
    });
    const internals = workflow as unknown as {
      activeBacklog: BacklogItem;
      observationContext: ObservationContext;
      executionMode: 'batch';
      autoWrapup: () => Promise<{ success: boolean }>;
      classifyFailure: (failure: unknown) => Promise<unknown>;
      runBody: (context: unknown) => Promise<{ success: boolean }>;
    };
    internals.activeBacklog = { id: workItemId, workItemId, providerRef: '42', title: 'Learning input', state: 'ready', executionMode: 'afk', branchName: 'feat/learning', dependsOn: [], tags: [] };
    internals.observationContext = { traceId: 'learning-trace', runId: 'learning-run', workItemId, profileId: 'development', attempt: 1, actor: { kind: 'system', id: 'learning-test' } };
    internals.executionMode = 'batch';
    const wrapup = vi.spyOn(internals, 'autoWrapup').mockResolvedValue({ success: true });
    const failure = vi.spyOn(internals, 'classifyFailure').mockImplementation(async diagnostic => diagnostic);
    await expect(internals.runBody({ iid: 42, session: 'learning-run', targetBranch: 'main', baseBranch: 'main',
      hardTimeoutMs: 10000, completionTimeoutMs: 10000, idleTimeoutMs: 10000, maxHandoffs: 2,
      contextHighTokens: 1000, maxTotalTokens: 10000, repoRoot: root, workspaceRoot: root,
      template: 'learning-input-test', executionMode: 'batch' })).resolves.toEqual({ success: true });
    expect(failure).not.toHaveBeenCalled();
    expect(wrapup).toHaveBeenCalledOnce();
    expect(createExecution).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      'learning.settings', 'learning.context', 'learning.jobs', 'learning.candidates', 'test.inspect-envelope',
    ]);
    expect(await dispatch.mock.results[1].value).toEqual(config.executionContexts[0]);
    expect(await dispatch.mock.results[2].value).toEqual([]);
    expect(await dispatch.mock.results[3].value).toEqual([]);
    expect(inspectEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      iid: 42, worktreePath: root, branch: 'feat/learning', targetBranch: 'main',
      step: expect.objectContaining({ id: 'inspect', kind: 'system', action: 'test.inspect-envelope' }), input: { scope },
    }), expect.objectContaining({ authorizedWorkspace: root }));
  });
});

async function incompleteReviewFixture(settings: {
  reason?: LearningReviewIncompleteError['output']['reason'];
  timeoutMs?: number;
  followUpOnFailure?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'learning-incomplete-'));
  roots.push(root);
  const internalFailure = new Error('private validation detail: secret-token');
  const incomplete = new LearningReviewIncompleteError({
    status: 'incomplete', scope: 'github:acme/api', runId: 'source-run', requestKey: 'a'.repeat(64),
    validated: [{ status: 'validated', candidateId: 'b'.repeat(64), candidateVersion: 3,
      validatedVersion: 4, executionId: 'current-validation', receiptDigest: 'c'.repeat(64) }],
    interruptedCandidateId: 'd'.repeat(64), reason: settings.reason ?? 'validation_blocked',
  }, { cause: internalFailure });
  const action = vi.fn(async (_input: unknown, _options?: PluginSystemActionOptions): Promise<unknown> => { throw incomplete; });
  const followUp = vi.fn(async () => ({ unexpected: true }));
  const hooks = {
    before: vi.fn(async () => {}), after: vi.fn(async () => {}),
    cleanup: vi.fn(async (context: LifecycleContext) => { expect(context.signal?.aborted).not.toBe(true); }),
  };
  const plugins = new PluginRuntime();
  runtimes.push(plugins);
  await plugins.activate({ id: 'test.learning-incomplete', version: '1.0.0', setup(context) {
    context.registerSystemAction('learning.retrospective', action);
    context.registerSystemAction('learning.follow-up', followUp);
    context.registerLifecycle({ name: 'incomplete-review', purposes: ['learning'], failureMode: 'required',
      onBeforeAgent: hooks.before, onAfterAgent: hooks.after, onCleanup: hooks.cleanup });
  } });
  const record = vi.fn(async (_context: ObservationContext, _data: RunEventData) => {});
  const forbidden = vi.fn(async () => { throw new Error('unexpected execution provider call'); });
  const watchdog = { arm: forbidden, disarm: vi.fn() };
  const runner = new WorkflowRunner(undefined, {
    plugins, observer: { record } as unknown as RunObserver,
    template: { name: 'learning-incomplete-test', version: 1, purpose: 'learning', steps: [
      { id: 'review', kind: 'system', action: 'learning.retrospective',
        input: { scope: 'github:acme/api', runId: 'source-run', kind: 'tool' },
        ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }) },
      { id: 'follow-up', kind: 'system', action: 'learning.follow-up', dependsOn: ['review'],
        ...(settings.followUpOnFailure ? { when: { step: 'review', equals: 'failed' } } : {}) },
    ] },
    agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution: forbidden },
    sandboxProvider: { name: 'local', isolation: 'filesystem', capabilities: new Set(),
      createWorktree: forbidden, create: forbidden },
    tmux: {} as never, watchdog: watchdog as never, prepareRuntime: forbidden,
  });
  const options: RunnerOptions = { backlogId: 'github:acme/api#42', session: 'learning-incomplete-test',
    targetBranch: 'main', repoRoot: root, executionMode: 'batch', hardTimeoutMs: 5000,
    observationRunId: 'review-run', observationWorkItemId: 'github:acme/api#42', auditRequired: true };
  const events = () => record.mock.calls.map(([, data]) => data);
  return { runner, options, action, followUp, hooks, record, events, incomplete, internalFailure, watchdog, forbidden };
}

function errorCauses(error: unknown): unknown[] {
  return [error,
    ...(error instanceof AggregateError ? error.errors.flatMap(errorCauses) : []),
    ...(error instanceof Error && error.cause !== undefined ? errorCauses(error.cause) : []),
  ];
}

describe('WorkflowRunner incomplete learning receipts', () => {
  it('stops failure-conditioned actions after an incomplete review', async () => {
    const test = await incompleteReviewFixture({ followUpOnFailure: true });
    await expect(test.runner.run(test.options)).rejects.toBe(test.incomplete);
    expect(test.followUp).not.toHaveBeenCalled();
    expect(test.hooks.after).not.toHaveBeenCalled();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.events().filter(event => event.kind === 'effect.started')).toEqual([
      expect.objectContaining({ effectKind: 'learning.retrospective' }),
    ]);
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
  });

  it('retains audit failure causes when a failure-conditioned action is stopped', async () => {
    const test = await incompleteReviewFixture({ followUpOnFailure: true });
    const auditFailure = new Error('private audit detail: secret-token');
    test.record.mockImplementation(async (_context, event) => {
      if (event.kind === 'effect.completed') throw auditFailure;
    });
    const error: unknown = await test.runner.run(test.options).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(LearningReviewIncompleteError);
    expect((error as LearningReviewIncompleteError).output).toEqual(test.incomplete.output);
    expect(errorCauses(error)).toContain(auditFailure);
    expect(errorCauses(error).some(cause => cause instanceof AuditPersistenceError)).toBe(true);
    expect(test.followUp).not.toHaveBeenCalled();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([]);
    expect(JSON.stringify(test.events())).not.toContain('secret-token');
  });

  it.each(['validation_blocked', 'validation_failed'] as const)('rejects a partial batch with exact receipts after %s', async reason => {
    const test = await incompleteReviewFixture({ reason });
    await expect(test.runner.run(test.options)).rejects.toBe(test.incomplete);
    expect(test.incomplete.output.validated).toEqual([{ status: 'validated', candidateId: 'b'.repeat(64),
      candidateVersion: 3, validatedVersion: 4, executionId: 'current-validation', receiptDigest: 'c'.repeat(64) }]);
    expect(test.hooks.before).toHaveBeenCalledOnce();
    expect(test.hooks.after).not.toHaveBeenCalled();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.followUp).not.toHaveBeenCalled();
    expect(test.forbidden).not.toHaveBeenCalled();
    expect(test.events().filter(event => event.kind === 'effect.completed')).toEqual([
      expect.objectContaining({ effectKind: 'learning.retrospective', outcome: 'failed', summary: 'learning_review_incomplete' }),
    ]);
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    expect(JSON.stringify(test.events())).not.toContain(test.internalFailure.message);
    expect(test.incomplete.cause).toBe(test.internalFailure);
  });

  it.each(['cancellation', 'step timeout', 'workflow timeout'] as const)('keeps committed receipts through %s before cleanup', async interruption => {
    const test = await incompleteReviewFixture({ reason: 'cancelled', timeoutMs: interruption === 'step timeout' ? 25 : undefined });
    const controller = new AbortController();
    let settled = false;
    test.action.mockImplementation(async (_input, options) => {
      const signal = options!.signal!;
      if (interruption === 'cancellation') controller.abort(new Error('private cancellation detail: secret-token'));
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      settled = true;
      throw test.incomplete;
    });
    test.hooks.cleanup.mockImplementation(async context => {
      expect(settled).toBe(true);
      expect(context.signal?.aborted).not.toBe(true);
    });
    await expect(test.runner.run({ ...test.options, signal: controller.signal,
      hardTimeoutMs: interruption === 'workflow timeout' ? 25 : 5000 })).rejects.toBe(test.incomplete);
    expect(test.hooks.after).not.toHaveBeenCalled();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.followUp).not.toHaveBeenCalled();
    expect(test.watchdog.disarm).toHaveBeenCalledOnce();
    expect(test.events().filter(event => event.kind === 'effect.completed')).toEqual([
      expect.objectContaining({ outcome: 'failed', summary: 'learning_review_incomplete' }),
    ]);
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: interruption === 'step timeout' ? 'failed' : 'cancelled' }),
    ]);
    expect(JSON.stringify(test.events())).not.toContain('secret-token');
  });

  it.each(['cleanup', 'effect audit', 'terminal audit', 'cleanup and terminal audit', 'outer finalization'] as const)(
    'retains typed receipts and internal causes when %s fails', async phase => {
      const test = await incompleteReviewFixture();
      const cleanupFailure = new Error('private cleanup detail: secret-token');
      const auditFailure = new Error('private storage detail: secret-token');
      const finalizationFailure = new Error('private finalization detail: secret-token');
      if (phase === 'cleanup' || phase === 'cleanup and terminal audit') {
        test.hooks.cleanup.mockRejectedValue(cleanupFailure);
      }
      if (phase === 'effect audit' || phase === 'terminal audit' || phase === 'cleanup and terminal audit') {
        test.record.mockImplementation(async (_context, event) => {
          if (event.kind === (phase === 'effect audit' ? 'effect.completed' : 'run.finished')) throw auditFailure;
        });
      }
      if (phase === 'outer finalization') test.watchdog.disarm.mockImplementation(() => { throw finalizationFailure; });
      const error: unknown = await test.runner.run(test.options).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(LearningReviewIncompleteError);
      expect((error as LearningReviewIncompleteError).output).toEqual(test.incomplete.output);
      const causes = errorCauses(error);
      expect(causes).toContain(test.incomplete);
      expect(causes).toContain(test.internalFailure);
      if (phase === 'cleanup' || phase === 'cleanup and terminal audit') expect(causes).toContain(cleanupFailure);
      if (phase === 'effect audit' || phase === 'terminal audit' || phase === 'cleanup and terminal audit') {
        expect(causes.some(cause => cause instanceof AuditPersistenceError)).toBe(true);
        expect(causes).toContain(auditFailure);
      }
      if (phase === 'outer finalization') expect(causes).toContain(finalizationFailure);
      expect(test.hooks.after).not.toHaveBeenCalled();
      expect(test.hooks.cleanup).toHaveBeenCalledOnce();
      expect(test.followUp).not.toHaveBeenCalled();
      const finished = test.events().filter(event => event.kind === 'run.finished');
      if (phase === 'effect audit') expect(finished).toEqual([]);
      else expect(finished).toEqual([expect.objectContaining({ outcome: 'failed' })]);
      expect(JSON.stringify(test.events())).not.toContain('secret-token');
    },
  );
});
