import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationContext, RunEventData } from '@afk/core';
import { WorkflowTemplateSchema, type Step, type WorkflowTemplate } from '../domain/templates/types.js';
import { TemplateLoader } from '../domain/templates/loader.js';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import type { RunObserver } from '../observability/run-observer.js';
import { AuditPersistenceError, WorkflowRunner, type RunnerDependencies, type RunnerOptions } from './workflow-engine.js';
import { PluginRuntime, type PluginSystemAction, type PluginSystemActionOptions } from './plugins/runtime.js';
import type { LifecycleContext } from './workflows/lifecycle.js';

const roots: string[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(settings: {
  steps?: Step[];
  action?: PluginSystemAction;
  hookFailure?: 'init' | 'before' | 'after';
  purpose?: 'execution' | 'learning' | null;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'learning-lifecycle-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  const forbidden = new Map<string, { mock: { calls: unknown[][] } }>();
  const denied = (name: string) => {
    const spy = vi.fn<unknown[], never>(() => { throw new Error(`forbidden ${name}`); });
    forbidden.set(name, spy);
    return spy;
  };
  const providers = {
    backlog: {
      get: denied('backlog.get'), claim: denied('backlog.claim'), transition: denied('backlog.transition'),
      block: denied('backlog.block'), release: denied('backlog.release'), heartbeat: denied('backlog.heartbeat'),
      adopt: denied('backlog.adopt'), list: denied('backlog.list'), planCreate: denied('backlog.planCreate'),
      create: denied('backlog.create'), setExecutionMode: denied('backlog.setExecutionMode'),
      createRework: denied('backlog.createRework'), getActiveRework: denied('backlog.getActiveRework'),
      resolveRework: denied('backlog.resolveRework'), reviseRework: denied('backlog.reviseRework'),
      addTag: denied('backlog.addTag'), removeTag: denied('backlog.removeTag'),
      applyRelationUpdate: denied('backlog.applyRelationUpdate'), applyRole: denied('backlog.applyRole'),
      applyMode: denied('backlog.applyMode'), applyExecutionBase: denied('backlog.applyExecutionBase'),
      applyPrdBaseline: denied('backlog.applyPrdBaseline'), initialize: denied('backlog.initialize'),
      isRunnable: denied('backlog.isRunnable'), explainRunnability: denied('backlog.explainRunnability'),
    },
    branches: {
      createBranch: denied('branches.createBranch'), createVerificationWorktree: denied('branches.createVerificationWorktree'),
      preparePush: denied('branches.preparePush'), push: denied('branches.push'), commit: denied('branches.commit'),
      cleanup: denied('branches.cleanup'), mergeFeatureIntoBaseline: denied('branches.mergeFeatureIntoBaseline'),
      listUnresolvedConflicts: denied('branches.listUnresolvedConflicts'),
    },
    changes: {
      create: denied('changes.create'), get: denied('changes.get'), findForBacklog: denied('changes.findForBacklog'),
      verifyIssueAssociation: denied('changes.verifyIssueAssociation'), refresh: denied('changes.refresh'),
      merge: denied('changes.merge'), close: denied('changes.close'),
    },
  } as unknown as ProviderBundle;
  const order: string[] = [];
  const hookError = new Error(`required ${settings.hookFailure} hook failed`);
  const hook = (phase: string) => vi.fn(async () => {
    order.push(phase);
    if (phase === settings.hookFailure) throw hookError;
  });
  const hooks = { init: hook('init'), before: hook('before'), after: hook('after'), cleanup: vi.fn(async (context: LifecycleContext) => {
    order.push('cleanup');
    expect(context.signal?.aborted).not.toBe(true);
  }) };
  const input = { scope: 'github:acme/api', limit: 2 };
  const action = vi.fn(async (value: unknown, options?: PluginSystemActionOptions) => {
    order.push('action');
    return settings.action ? settings.action(value, options) : { learned: true };
  });
  const plugins = new PluginRuntime();
  runtimes.push(plugins);
  const template = { name: 'learning-lifecycle-test', version: 1,
    ...(settings.purpose === null ? {} : { purpose: settings.purpose ?? 'learning' }),
    steps: settings.steps ?? [{ id: 'learn', kind: 'system', action: 'learning.lifecycle-test', input }],
  } satisfies WorkflowTemplate & { purpose?: 'execution' | 'learning' };
  await plugins.activate({ id: 'test.learning-lifecycle', version: '1.0.0', setup(context) {
    context.registerSystemAction('learning.lifecycle-test', action);
    context.registerWorkflowTemplate(template);
    const lifecycle = { name: 'learning-lifecycle-required', failureMode: 'required' as const,
      purposes: ['learning'] as Array<'execution' | 'learning'>,
      onInit: hooks.init, onBeforeAgent: hooks.before, onAfterAgent: hooks.after, onCleanup: hooks.cleanup };
    context.registerLifecycle(lifecycle);
    context.registerLifecycle({ name: 'default-execution-only', failureMode: 'required',
      onInit: denied('defaultExecution.init'), onBeforeAgent: denied('defaultExecution.before'),
      onAfterAgent: denied('defaultExecution.after'), onCleanup: denied('defaultExecution.cleanup') });
  } });
  const record = vi.fn(async (_context: ObservationContext, _data: RunEventData) => {});
  const watchdog = { arm: denied('watchdog.arm'), disarm: vi.fn() };
  const runner = new WorkflowRunner(providers, {
    plugins, observer: { record } as unknown as RunObserver,
    agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution: denied('agent.createExecution') },
    sandboxProvider: { name: 'local', create: denied('sandbox.create') }, watchdog,
    runtimeManager: {
      start: denied('taskRuntime.start'), heartbeat: denied('taskRuntime.heartbeat'),
      appendActivity: denied('taskRuntime.appendActivity'), finish: denied('taskRuntime.finish'),
      writeDiagnostics: denied('taskRuntime.writeDiagnostics'), listActive: denied('taskRuntime.listActive'),
      listArchive: denied('taskRuntime.listArchive'), listByBacklogId: denied('taskRuntime.listByBacklogId'),
    },
    tmux: {
      openSession: denied('tmux.openSession'), closeSession: denied('tmux.closeSession'),
      createSession: denied('tmux.createSession'), firstPaneId: denied('tmux.firstPaneId'),
      hasSession: denied('tmux.hasSession'), sessionStatus: denied('tmux.sessionStatus'),
      setSessionOwnership: denied('tmux.setSessionOwnership'), sessionOwnership: denied('tmux.sessionOwnership'),
      listSessions: denied('tmux.listSessions'), killSession: denied('tmux.killSession'),
      newWindow: denied('tmux.newWindow'), listWindows: denied('tmux.listWindows'),
      isInsideTmux: denied('tmux.isInsideTmux'), attach: denied('tmux.attach'), sendKeys: denied('tmux.sendKeys'),
      capturePane: denied('tmux.capturePane'), waitForPrompt: denied('tmux.waitForPrompt'),
      sendPrompt: denied('tmux.sendPrompt'), waitForSignal: denied('tmux.waitForSignal'),
      waitForAnySignal: denied('tmux.waitForAnySignal'), waitSessionExit: denied('tmux.waitSessionExit'),
    },
    prepareRuntime: denied('agent.prepareRuntime'),
    multiRepositoryPreparer: { prepare: denied('repositories.prepare') },
  } as unknown as RunnerDependencies);
  const options: RunnerOptions = { backlogId: 'github:acme/api#42', session: 'learning-lifecycle-test', targetBranch: 'main',
    repoRoot: root, template: template.name, executionMode: 'batch', hardTimeoutMs: 5000,
    observationRunId: 'learning-lifecycle-run', observationWorkItemId: 'github:acme/api#42', auditRequired: true };
  const events = () => record.mock.calls.map(([, data]) => data);
  const assertIsolated = () => {
    for (const [name, spy] of forbidden) expect(spy.mock.calls, name).toEqual([]);
    expect(git('rev-parse', 'HEAD')).toBe(baseline);
    expect(git('branch', '--format=%(refname:short)')).toBe('main');
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(events().map(event => event.kind)).not.toContain('implementation.completed');
    expect(events().map(event => event.kind)).not.toContain('qa.passed');
  };
  return { root, git, baseline, runner, plugins, providers, template, options, input, action, hooks, hookError, order, record, events, assertIsolated };
}

describe('WorkflowRunner public learning lifecycle', () => {
  it('honors the step deadline and awaits cooperative action settlement before cleanup', async () => {
    let settled = false;
    const test = await fixture({
      steps: [{ id: 'learn', kind: 'system', action: 'learning.lifecycle-test', input: {}, timeoutMs: 25 }],
      action: async (_input, options) => {
        const signal = options!.signal!;
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        settled = true;
      },
    });
    test.hooks.cleanup.mockImplementation(async () => { expect(settled).toBe(true); });
    await expect(test.runner.run({ ...test.options, hardTimeoutMs: 1000 })).resolves.toMatchObject({ success: false,
      steps: { learn: { status: 'timed_out' } } });
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    test.assertIsolated();
  });

  it('runs an explicitly learning template with strict input, authorized workspace and learning audit context', async () => {
    const test = await fixture();
    await expect(test.runner.run(test.options)).resolves.toMatchObject({ success: true });
    expect(test.action).toHaveBeenCalledOnce();
    expect(test.action).toHaveBeenCalledWith(test.input, expect.objectContaining({
      authorizedWorkspace: test.root, signal: expect.any(AbortSignal),
    }));
    expect(test.order).toEqual(['init', 'before', 'action', 'after', 'cleanup']);
    expect(test.record.mock.calls.length).toBeGreaterThan(0);
    for (const [context] of test.record.mock.calls) expect(context).toMatchObject({ purpose: 'learning',
      runId: test.options.observationRunId, workItemId: test.options.observationWorkItemId });
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ kind: 'run.finished', outcome: 'succeeded' }),
    ]);
    const effects = test.events().filter(event => event.kind === 'effect.started' || event.kind === 'effect.completed');
    expect(effects).toEqual([
      expect.objectContaining({ kind: 'effect.started', effectKind: expect.any(String), idempotencyKey: expect.any(String) }),
      expect.objectContaining({ kind: 'effect.completed', outcome: 'succeeded', idempotencyKey: effects[0]?.idempotencyKey }),
    ]);
    expect(test.hooks.before).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: test.root,
      repoRoot: test.root, observation: expect.objectContaining({ context: expect.objectContaining({ purpose: 'learning' }) }) }));
    test.assertIsolated();
  });

  it.each(['before-agent', 'after-agent'] as const)('audits an optional %s failure with the learning run identity and continues', async phase => {
    const test = await fixture();
    const hookName = phase === 'before-agent' ? 'onBeforeAgent' : 'onAfterAgent';
    await test.plugins.activate({ id: 'test.optional-hook-audit', version: '1.0.0', setup(context) {
      context.registerLifecycle({ name: 'optional-learning', purposes: ['learning'], failureMode: 'best-effort',
        [hookName]: async () => { throw new Error('token=private-hook-secret'); } });
    } });

    await expect(test.runner.run(test.options)).resolves.toMatchObject({ success: true });

    const failures = test.record.mock.calls.filter(([, event]) => event.kind === 'effect.completed' && event.outcome === 'failed');
    expect(failures).toEqual([[expect.objectContaining({ purpose: 'learning', runId: test.options.observationRunId,
      workItemId: test.options.observationWorkItemId }), {
      kind: 'effect.completed', effectKind: `workflow.lifecycle.${phase}`,
      idempotencyKey: JSON.stringify([test.options.observationRunId, 'lifecycle', phase, 'module', 'optional-learning']),
      outcome: 'failed', summary: 'optional_lifecycle_hook_failed',
    }]]);
    expect(JSON.stringify(test.events())).not.toContain('private-hook-secret');
    expect(test.action).toHaveBeenCalledOnce();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    test.assertIsolated();
  });

  it.each(['before-agent', 'after-agent'] as const)('stops learning when the optional %s failure cannot be audited and still cleans up', async phase => {
    const test = await fixture();
    const hookName = phase === 'before-agent' ? 'onBeforeAgent' : 'onAfterAgent';
    const later = vi.fn(async () => {});
    await test.plugins.activate({ id: 'test.optional-hook-audit', version: '1.0.0', setup(context) {
      context.registerLifecycle({ name: 'optional-learning', purposes: ['learning'], failureMode: 'best-effort',
        [hookName]: async () => { throw new Error('optional hook failed'); } });
      context.registerLifecycle({ name: 'later-learning', purposes: ['learning'], [hookName]: later });
    } });
    const storageFailure = new Error('hook audit unavailable');
    test.record.mockImplementation(async (_context, event) => {
      if (event.kind === 'effect.completed' && event.effectKind === `workflow.lifecycle.${phase}`) throw storageFailure;
    });

    await expect(test.runner.run(test.options)).rejects.toMatchObject({ name: 'AuditPersistenceError', cause: storageFailure });

    expect(later).not.toHaveBeenCalled();
    expect(test.action).toHaveBeenCalledTimes(phase === 'before-agent' ? 0 : 1);
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([]);
    test.assertIsolated();
  });

  it('preserves an explicit learning purpose and forwards only the declared action input', async () => {
    const test = await fixture({ steps: [{ id: 'learn', kind: 'system', action: 'learning.lifecycle-test', input: { run: 'explicit', nested: { enabled: true } } }] });
    await expect(test.runner.run({ ...test.options, purpose: 'learning', iid: 42, baseBranch: 'main',
      baseBranchExplicit: true, extParams: ['learning-lifecycle-required.enabled=true'] })).resolves.toMatchObject({ success: true });
    expect(test.action).toHaveBeenCalledWith({ run: 'explicit', nested: { enabled: true } }, expect.objectContaining({ authorizedWorkspace: test.root }));
    expect(test.hooks.before).toHaveBeenCalledWith(expect.objectContaining({ params: { 'learning-lifecycle-required': { enabled: 'true' } } }));
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    test.assertIsolated();
  });

  it('returns success false for a failed action and audits failure before cleaning up once', async () => {
    const failure = new Error('learning action failed');
    const test = await fixture({ action: async () => { throw failure; } });
    await expect(test.runner.run(test.options)).resolves.toMatchObject({ success: false });
    expect(test.action).toHaveBeenCalledOnce();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.events().filter(event => event.kind === 'effect.completed')).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    test.assertIsolated();
  });

  it('executes the same validated template even if a hook changes the plugin registration', async () => {
    const test = await fixture();
    test.hooks.init.mockImplementation(async () => {
      test.template.steps.splice(0, test.template.steps.length, { id: 'unsafe', kind: 'system', action: 'publish-change' });
    });
    await expect(test.runner.run(test.options)).resolves.toMatchObject({ success: true });
    expect(test.action).toHaveBeenCalledOnce();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    test.assertIsolated();
  });

  it('propagates cancellation after an action starts and audits cancelled with independent cleanup', async () => {
    const caller = new AbortController();
    const cancelled = new Error('caller cancelled learning');
    const test = await fixture({ action: async (_input, options) => {
      expect(options?.signal?.aborted).toBe(false);
      caller.abort(cancelled);
      expect(options?.signal?.aborted).toBe(true);
      return { learned: true };
    } });
    await expect(test.runner.run({ ...test.options, signal: caller.signal })).rejects.toBe(cancelled);
    expect(test.action).toHaveBeenCalledOnce();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.order.at(-1)).toBe('cleanup');
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: 'cancelled' }),
    ]);
    test.assertIsolated();
  });

  it('waits for already started sibling actions to settle before cancellation cleanup and rejection', async () => {
    const caller = new AbortController();
    const cancelled = new Error('cancel parallel learning');
    let markStarted!: () => void;
    let markCancelled!: () => void;
    let releaseSibling!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const cancellation = new Promise<void>(resolve => { markCancelled = resolve; });
    const siblingGate = new Promise<void>(resolve => { releaseSibling = resolve; });
    const settledOrder: string[] = [];
    const test = await fixture({ steps: [
      { id: 'cancel', kind: 'system', action: 'learning.lifecycle-test', input: { cancel: true } },
      { id: 'sibling', kind: 'system', action: 'learning.lifecycle-test', input: { cancel: false } },
    ], action: async input => {
      const payload = input as { cancel?: boolean; input?: { cancel: boolean } };
      if ((payload.input ?? payload).cancel) {
        await started;
        caller.abort(cancelled);
        markCancelled();
      } else {
        markStarted();
        await siblingGate;
        settledOrder.push('sibling settled');
      }
      return { learned: true };
    } });
    test.hooks.cleanup.mockImplementation(async context => {
      expect(context.signal?.aborted).not.toBe(true);
      settledOrder.push('cleanup');
    });
    let returned = false;
    const pending = test.runner.run({ ...test.options, signal: caller.signal }).then(
      result => { returned = true; return { result }; },
      error => { returned = true; return { error }; },
    );
    try {
      const first = await Promise.race([cancellation.then(() => 'cancelled'), pending.then(() => 'returned')]);
      expect(first).toBe('cancelled');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(returned).toBe(false);
      expect(test.hooks.cleanup).not.toHaveBeenCalled();
      releaseSibling();
      await expect(pending).resolves.toEqual({ error: cancelled });
      expect(test.action).toHaveBeenCalledTimes(2);
      expect(test.hooks.cleanup).toHaveBeenCalledOnce();
      expect(settledOrder).toEqual(['sibling settled', 'cleanup']);
      expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
        expect.objectContaining({ outcome: 'cancelled' }),
      ]);
      test.assertIsolated();
    } finally {
      releaseSibling();
      await pending;
    }
  });

  it.each(['init', 'before', 'after'] as const)('propagates required %s hook failure and always cleans up once', async hookFailure => {
    const test = await fixture({ hookFailure });
    await expect(test.runner.run(test.options)).rejects.toBe(test.hookError);
    expect(test.action).toHaveBeenCalledTimes(hookFailure === 'after' ? 1 : 0);
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.order.at(-1)).toBe('cleanup');
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    test.assertIsolated();
  });

  it.each(['effect.started', 'effect.completed', 'run.finished'] as const)('propagates required audit failure at %s and cleans up once', async eventKind => {
    const test = await fixture({ steps: [
      { id: 'learn', kind: 'system', action: 'learning.lifecycle-test' },
      { id: 'recover', kind: 'system', action: 'learning.lifecycle-test', dependsOn: ['learn'], when: { step: 'learn', equals: 'failed' } },
    ] });
    test.record.mockImplementation(async (_context, event) => {
      if (event.kind === eventKind) throw new Error('audit storage unavailable');
    });
    await expect(test.runner.run(test.options)).rejects.toThrow(/audit.*storage unavailable/);
    expect(test.action).toHaveBeenCalledTimes(eventKind === 'effect.started' ? 0 : 1);
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    test.assertIsolated();
  });

  it('review regression: prevents a sibling action starting after another step audit fails while its started audit is pending', async () => {
    let markSiblingStarted!: () => void;
    let markAuditFailed!: () => void;
    let releaseSiblingAudit!: () => void;
    const siblingStarted = new Promise<void>(resolve => { markSiblingStarted = resolve; });
    const auditFailed = new Promise<void>(resolve => { markAuditFailed = resolve; });
    const siblingAuditGate = new Promise<void>(resolve => { releaseSiblingAudit = resolve; });
    const storageFailure = new Error('first step started audit unavailable');
    const test = await fixture({ steps: [
      { id: 'first', kind: 'system', action: 'learning.lifecycle-test', input: { step: 'first' } },
      { id: 'sibling', kind: 'system', action: 'learning.lifecycle-test', input: { step: 'sibling' } },
    ] });
    test.record.mockImplementation(async (_context, event) => {
      if (event.kind !== 'effect.started') return;
      if (event.idempotencyKey === `${test.options.observationRunId}:first`) {
        await siblingStarted;
        markAuditFailed();
        throw storageFailure;
      }
      if (event.idempotencyKey === `${test.options.observationRunId}:sibling`) {
        markSiblingStarted();
        await siblingAuditGate;
      }
    });
    const pending = test.runner.run(test.options).then(
      result => ({ result }), error => ({ error }),
    );
    try {
      const first = await Promise.race([auditFailed.then(() => 'audit failed'), pending.then(() => 'run returned')]);
      expect(first).toBe('audit failed');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(test.action).not.toHaveBeenCalled();
      expect(test.hooks.cleanup).not.toHaveBeenCalled();
      releaseSiblingAudit();
      const outcome = await pending;
      expect(outcome).toHaveProperty('error');
      if (!('error' in outcome)) throw new Error('expected required audit failure');
      expect(outcome.error).toBeInstanceOf(AuditPersistenceError);
      expect((outcome.error as AuditPersistenceError).cause).toBe(storageFailure);
      expect(test.hooks.cleanup).toHaveBeenCalledOnce();
      test.assertIsolated();
      expect(test.action).not.toHaveBeenCalled();
    } finally {
      releaseSiblingAudit();
      await pending;
    }
  });

  it.each(['hook', 'cleanup', 'hook and cleanup'] as const)('review regression: retains %s errors when run.finished persistence also fails', async source => {
    const test = await fixture({ hookFailure: source === 'cleanup' ? undefined : 'before' });
    const cleanupFailure = new Error('cleanup ownership retained');
    const storageFailure = new Error('terminal audit disk unavailable');
    const expectedFailures = source === 'cleanup' ? [cleanupFailure] : [test.hookError];
    if (source !== 'hook') {
      test.hooks.cleanup.mockImplementation(async context => {
        test.order.push('cleanup');
        expect(context.signal?.aborted).not.toBe(true);
        throw cleanupFailure;
      });
      if (source === 'hook and cleanup') expectedFailures.push(cleanupFailure);
    }
    test.record.mockImplementation(async (_context, event) => {
      if (event.kind === 'run.finished') throw storageFailure;
    });
    const rejection: unknown = await test.runner.run(test.options).then(() => undefined, error => error);
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.action).toHaveBeenCalledTimes(source === 'cleanup' ? 1 : 0);
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    test.assertIsolated();
    const causes: unknown[] = [];
    const collectCauses = (error: unknown): void => {
      causes.push(error);
      if (error instanceof AggregateError) error.errors.forEach(collectCauses);
      if (error instanceof Error && error.cause !== undefined) collectCauses(error.cause);
    };
    collectCauses(rejection);
    const auditFailure = causes.find((error): error is AuditPersistenceError => error instanceof AuditPersistenceError);
    expect(auditFailure?.cause).toBe(storageFailure);
    expect(auditFailure?.message).toContain("'run.finished'");
    for (const original of expectedFailures) expect(causes).toContain(original);
    expect(rejection).toBeInstanceOf(AggregateError);
  });

  it('review additional: runs timed_out recovery after siblings settle and skips ordinary timeout dependents', async () => {
    let markSiblingStarted!: () => void;
    let markTimeoutSettled!: () => void;
    let releaseSibling!: () => void;
    const siblingStarted = new Promise<void>(resolve => { markSiblingStarted = resolve; });
    const timeoutSettled = new Promise<void>(resolve => { markTimeoutSettled = resolve; });
    const siblingGate = new Promise<void>(resolve => { releaseSibling = resolve; });
    const order: string[] = [];
    const test = await fixture({ steps: [
      { id: 'timeout', kind: 'system', action: 'learning.lifecycle-test', input: { step: 'timeout' }, timeoutMs: 25 },
      { id: 'sibling', kind: 'system', action: 'learning.lifecycle-test', input: { step: 'sibling' } },
      { id: 'recovery', kind: 'system', action: 'learning.lifecycle-test', input: { step: 'recovery' },
        dependsOn: ['timeout'], when: { step: 'timeout', equals: 'timed_out' } },
      { id: 'downstream', kind: 'system', action: 'learning.lifecycle-test', input: { step: 'downstream' }, dependsOn: ['timeout'] },
    ], action: async (input, options) => {
      const { step } = input as { step: string };
      const signal = options!.signal!;
      if (step === 'timeout') {
        await siblingStarted;
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        order.push('timeout settled');
        markTimeoutSettled();
      } else if (step === 'sibling') {
        markSiblingStarted();
        await siblingGate;
        expect(signal.aborted).toBe(false);
        order.push('sibling settled');
      } else {
        expect(signal.aborted).toBe(false);
        order.push(step);
      }
    } });
    test.hooks.cleanup.mockImplementation(async context => {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(context.signal!.aborted).toBe(false);
      order.push('cleanup');
    });
    let returned = false;
    const pending = test.runner.run(test.options).finally(() => { returned = true; });
    try {
      await timeoutSettled;
      expect(returned).toBe(false);
      expect(order).toEqual(['timeout settled']);
      expect(test.hooks.cleanup).not.toHaveBeenCalled();
      releaseSibling();
      await expect(pending).resolves.toMatchObject({ success: false, steps: {
        timeout: { status: 'timed_out' }, sibling: { status: 'completed' }, recovery: { status: 'completed' },
      } });
      expect(order).toEqual(['timeout settled', 'sibling settled', 'recovery', 'cleanup']);
      expect(test.action.mock.calls.map(([input]) => (input as { step: string }).step)).toEqual(['timeout', 'sibling', 'recovery']);
      expect(test.hooks.cleanup).toHaveBeenCalledOnce();
      expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([
        expect.objectContaining({ outcome: 'failed' }),
      ]);
      test.assertIsolated();
    } finally {
      releaseSibling();
      await pending.catch(() => undefined);
    }
  });

  it('review additional: preserves hook audit and cleanup failures without appending run.finished', async () => {
    const storageFailure = new Error('hook observation storage unavailable');
    const cleanupFailure = new Error('cleanup failed after hook audit failure');
    const test = await fixture();
    const before = vi.fn(async (context: LifecycleContext) => {
      await context.observation!.record({ kind: 'effect.started', effectKind: 'review-hook-audit', idempotencyKey: 'review-hook-audit' });
    });
    await test.plugins.activate({ id: 'test.review-additional-hook', version: '1.0.0', setup(context) {
      context.registerLifecycle({ name: 'review-additional-hook', failureMode: 'required', purposes: ['learning'], onBeforeAgent: before });
    } });
    test.record.mockImplementation(async (_context, event) => {
      if (event.kind === 'effect.started' && event.effectKind === 'review-hook-audit') throw storageFailure;
    });
    test.hooks.cleanup.mockImplementation(async context => {
      expect(context.signal!.aborted).toBe(false);
      throw cleanupFailure;
    });
    const rejection: unknown = await test.runner.run(test.options).then(() => undefined, error => error);
    expect(before).toHaveBeenCalledOnce();
    expect(test.action).not.toHaveBeenCalled();
    expect(test.hooks.cleanup).toHaveBeenCalledOnce();
    expect(test.events().filter(event => event.kind === 'run.finished')).toEqual([]);
    expect(test.events().filter(event => event.kind === 'effect.started')).toEqual([
      expect.objectContaining({ effectKind: 'review-hook-audit' }),
    ]);
    const causes: unknown[] = [];
    const collectCauses = (error: unknown): void => {
      causes.push(error);
      if (error instanceof AggregateError) error.errors.forEach(collectCauses);
      if (error instanceof Error && error.cause !== undefined) collectCauses(error.cause);
    };
    collectCauses(rejection);
    const auditFailure = causes.find((error): error is AuditPersistenceError => error instanceof AuditPersistenceError);
    expect(auditFailure?.cause).toBe(storageFailure);
    expect(causes).toContain(cleanupFailure);
    expect(rejection).toBeInstanceOf(AggregateError);
    test.assertIsolated();
  });

  it.each([
    { name: 'explicit agent', step: { id: 'unsafe', kind: 'agent', role: 'implementer', prompt: 'must not run' } },
    { name: 'legacy agent', step: { id: 'unsafe', role: 'implementer', prompt: 'must not run' } },
    { name: 'publish action', step: { id: 'unsafe', kind: 'system', action: 'publish-change' } },
    { name: 'QA action', step: { id: 'unsafe', kind: 'system', action: 'queue-qa' } },
    { name: 'other plugin action', step: { id: 'unsafe', kind: 'system', action: 'other.learning' } },
  ] satisfies Array<{ name: string; step: Step }>)('rejects $name at schema loading before any hook or action', async ({ step }) => {
    const test = await fixture({ steps: [step] });
    expect(WorkflowTemplateSchema.safeParse(test.template).success).toBe(false);
    const loader = new TemplateLoader({ getPluginTemplate: name => test.plugins.getTemplate(name) });
    await expect(loader.load(test.template.name)).rejects.toThrow(/invalid plugin template/);
    await expect(test.runner.run(test.options)).rejects.toThrow(/learning|invalid.*template/i);
    expect(test.order).toEqual([]);
    test.assertIsolated();
  });

  it.each([
    { name: 'default branch', overrides: { defaultBranch: { type: 'named', branch: 'feat/forbidden' } } },
    { name: 'default provider', overrides: { defaultProvider: 'claude-code' } },
    ...[
      { role: 'implementer' }, { prompt: 'must not run' }, { provider: 'claude-code' },
      { executionMode: 'batch' }, { branch: { type: 'named', branch: 'feat/forbidden' } },
      { completion: 'goal_complete' },
    ].map(fields => ({ name: `step ${Object.keys(fields)[0]}`, overrides: {
      steps: [{ id: 'learn', kind: 'system', action: 'learning.lifecycle-test', ...fields }],
    } })),
  ])('rejects learning agent execution field $name at schema loading', async ({ overrides }) => {
    const test = await fixture();
    Object.assign(test.template, overrides);
    expect(WorkflowTemplateSchema.safeParse(test.template).success).toBe(false);
    const loader = new TemplateLoader({ getPluginTemplate: name => test.plugins.getTemplate(name) });
    await expect(loader.load(test.template.name)).rejects.toThrow(/invalid plugin template/);
    await expect(test.runner.run(test.options)).rejects.toThrow(/learning|invalid.*template/i);
    expect(test.order).toEqual([]);
    test.assertIsolated();
  });

  it.each([
    { name: 'unknown learning action', steps: [
      { id: 'valid', kind: 'system', action: 'learning.lifecycle-test' },
      { id: 'unknown', kind: 'system', action: 'learning.unregistered-test', dependsOn: ['valid'] },
    ], error: /unknown system action.*learning\.unregistered-test/i },
    { name: 'missing dependency', steps: [
      { id: 'valid', kind: 'system', action: 'learning.lifecycle-test' },
      { id: 'invalid', kind: 'system', action: 'learning.lifecycle-test', dependsOn: ['missing'] },
    ], error: /unknown step.*missing/i },
    { name: 'cycle without a terminal node', steps: [
      { id: 'valid', kind: 'system', action: 'learning.lifecycle-test' },
      { id: 'first', kind: 'system', action: 'learning.lifecycle-test', dependsOn: ['second'] },
      { id: 'second', kind: 'system', action: 'learning.lifecycle-test', dependsOn: ['first'] },
    ], error: /cycle/i },
    { name: 'unknown conditional dependency', steps: [
      { id: 'valid', kind: 'system', action: 'learning.lifecycle-test' },
      { id: 'invalid', kind: 'system', action: 'learning.lifecycle-test', when: { step: 'missing', equals: 'completed' } },
    ], error: /unknown step.*missing/i },
  ] satisfies Array<{ name: string; steps: Step[]; error: RegExp }>)('compiles and rejects $name before even an independent valid action or lifecycle hook', async ({ steps, error }) => {
    const test = await fixture({ steps });
    await expect(test.runner.run(test.options)).rejects.toThrow(error);
    expect(test.order).toEqual([]);
    test.assertIsolated();
  });

  it('rejects an empty learning template rather than reporting success without an action', async () => {
    const test = await fixture({ steps: [] });
    expect(WorkflowTemplateSchema.safeParse(test.template).success).toBe(false);
    await expect(test.runner.run(test.options)).rejects.toThrow(/learning|invalid.*template/i);
    expect(test.order).toEqual([]);
    test.assertIsolated();
  });

  it('rejects an execution-purpose option conflicting with a learning template', async () => {
    const test = await fixture();
    await expect(test.runner.run({ ...test.options, purpose: 'execution' })).rejects.toThrow(/purpose|learning.*execution/i);
    expect(test.order).toEqual([]);
    test.assertIsolated();
  });

  it('rejects managed repositories on a learning template before preparing or publishing anything', async () => {
    const test = await fixture();
    const repositories: NonNullable<RunnerOptions['repositories']> = [{ name: 'primary', primary: true,
      platform: 'github', projectKey: 'acme/api', checkoutPath: '.', repoRoot: test.root,
      baseBranch: 'main', workingBranch: 'feat/learning' }];
    await expect(test.runner.run({ ...test.options, repositories })).rejects.toThrow(/learning.*repositor|repositor.*learning/i);
    expect(test.order).toEqual([]);
    test.assertIsolated();
  });

  it('leaves learning-created workspace changes uncommitted and never pushes to an actual local remote', async () => {
    let root: string;
    const test = await fixture({ action: async () => { await writeFile(join(root, 'learning-result.txt'), 'learned\n'); } });
    root = test.root;
    const remote = join(test.root, '.git', 'learning-remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    test.git('remote', 'add', 'origin', remote);
    const pushMarker = join(test.root, '.git', 'learning-push-attempted');
    await writeFile(join(test.root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ntouch "$(git rev-parse --git-path learning-push-attempted)"\nexit 1\n', { mode: 0o755 });
    await expect(test.runner.run(test.options)).resolves.toMatchObject({ success: true });
    expect(test.git('status', '--porcelain')).toBe('?? learning-result.txt');
    expect(execFileSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' })).toBe('');
    await expect(access(pushMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    test.assertIsolated();
  });

  it.each([null, 'execution'] as const)('preserves claim behavior for a %s template even with options.purpose learning', async purpose => {
    const test = await fixture({ purpose });
    vi.mocked(test.providers.backlog.get).mockResolvedValue({ id: test.options.backlogId, title: 'ordinary execution', state: 'ready' } as never);
    vi.mocked(test.providers.backlog.claim).mockResolvedValue(null);
    await expect(test.runner.run({ ...test.options, purpose: 'learning', baseBranchExplicit: true })).resolves.toEqual({ success: false, skipped: 'not_claimed' });
    expect(test.providers.backlog.get).toHaveBeenCalledWith(test.options.backlogId);
    expect(test.providers.backlog.claim).toHaveBeenCalledWith(test.options.backlogId, test.options.session);
    expect(test.action).not.toHaveBeenCalled();
    expect(test.order).toEqual([]);
    expect(test.events().map(event => event.kind)).not.toContain('implementation.completed');
  });
});
