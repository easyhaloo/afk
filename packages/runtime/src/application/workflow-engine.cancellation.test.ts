import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AuditPersistenceError, WorkflowRunner, type RunnerOptions } from './workflow-engine.js';
import { QARunner } from './runners/qa-runner.js';
import { PluginRuntime } from './plugins/runtime.js';
import { createCapabilityLifecycle, registerVerificationSystemActions } from './plugins/integrations.js';
import { invokeCapability } from './plugins/operations.js';
import { getWorkflowConfig } from '../infrastructure/config/manager.js';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import type { ProviderAbortSignal, ProviderOperationOptions } from '../plugin-sdk/capabilities.js';
import type { LifecycleContext, InitContext } from './workflows/lifecycle.js';
import { LifecycleDispatcher } from './workflows/lifecycle.js';
import type { RunResourceScope } from './workflows/resource-scope.js';
import { CommandVerificationProvider } from '../infrastructure/verification/command.js';
import { FilesystemClaimLock, type ClaimLease } from '../domain/backlog/claim.js';

const earlyClaimIo = vi.hoisted(() => ({ target: '', remaining: 0, errors: [] as Error[] }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]) === earlyClaimIo.target && earlyClaimIo.remaining > 0) {
      earlyClaimIo.remaining--;
      const error = Object.assign(new Error('early claim own release EIO'), { code: 'EIO' });
      earlyClaimIo.errors.push(error);
      throw error;
    }
    return actual.rm(...args);
  } };
});

type Phase = 'init' | 'before-agent' | 'after-agent' | 'before-publish' | 'action';
type Kind = 'workflow' | 'qa';
const roots: string[] = [];
const runtimes: PluginRuntime[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  earlyClaimIo.remaining = 0;
  earlyClaimIo.target = '';
  vi.useRealTimers();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T | 'still pending'> {
  const timer = new AbortController();
  try { return await Promise.race([promise, delay(1500, 'still pending' as const, { signal: timer.signal })]); }
  finally { timer.abort(); }
}

async function fixture(kind: Kind, phase: Phase, processHook: boolean | 'verification' = false, repositoryLease = false) {
  const root = await mkdtemp(join(tmpdir(), 'afk-hook-cancellation-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'tracked'), 'baseline');
  execFileSync('git', ['-C', root, 'add', 'tracked']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline']);
  const entered = deferred<void>();
  const gate = deferred<void>();
  const contexts: ProviderAbortSignal[] = [];
  const providerSignals: Array<ProviderAbortSignal | undefined> = [];
  const cleanupSignals: Array<ProviderAbortSignal | undefined> = [];
  const processExited = deferred<void>();
  let child: ChildProcess | undefined;
  let hang = true;
  let currentPhase: Phase = 'init';
  const pidFile = join(root, 'verification.pid');
  const commandProvider = new CommandVerificationProvider('command', 'test-execution', [process.execPath, '-e',
    'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidFile]);
  const block = async (options?: ProviderOperationOptions) => {
    providerSignals.push(options?.signal);
    if (hang && currentPhase === phase) {
      if (processHook === true) {
        child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
        children.push(child);
        const processReady = deferred<void>();
        child.stdout!.once('data', () => processReady.resolve());
        child.once('exit', () => processExited.resolve());
        await processReady.promise;
      }
      entered.resolve();
      await new Promise<void>((resolve, reject) => {
        const abort = async () => {
          if (child) { child.kill('SIGKILL'); await processExited.promise; }
          reject(options?.signal?.reason);
        };
        options?.signal?.addEventListener('abort', abort, { once: true });
        void gate.promise.then(() => { options?.signal?.removeEventListener('abort', abort); resolve(); });
        if (options?.signal?.aborted) void abort();
      });
    }
  };
  const item = { id: '42', providerRef: '42', title: 'Cancellation contract', kind: 'task', state: kind === 'qa' ? 'verification' : 'ready', executionMode: 'afk', branchName: 'feat/task', dependsOn: [], tags: [] };
  const heartbeat = vi.fn(async () => {});
  const repositoryHeartbeat = vi.fn(async () => {});
  const finishWorkspace = vi.fn(async () => {});
  const releaseWorkspace = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const commit = vi.fn(async () => ({ sha: '', skippedBinaryFiles: [] }));
  const push = vi.fn(async () => {});
  const notify = vi.fn(async () => ({ delivered: true, channel: 'local' }));
  const change = { id: 'pr42', url: 'https://example.test/42', sourceBranch: 'feat/task', targetBranch: 'main', state: 'open', mergeState: 'mergeable' };
  const create = vi.fn(async () => change);
  const providers = {
    backlog: { get: vi.fn(async () => ({ ...item })), claim: vi.fn(async () => ({ item, heartbeat, release })),
      getActiveRework: vi.fn(async () => undefined), transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}) },
    branches: { createBranch: vi.fn(async () => ({ worktreePath: root, branchName: 'feat/task' })),
      createVerificationWorktree: vi.fn(async () => ({ worktreePath: root, branchName: 'feat/task' })),
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })), commit, push, cleanup: vi.fn(async () => {}) },
    changes: { findForBacklog: vi.fn(async () => null), create, get: vi.fn(async () => change) },
  };
  const execution = { id: 'local-agent', metadata: { provider: 'claude-code', transport: 'process' },
    waitForResult: vi.fn(async () => ({ version: 1, runId: 'local-agent', status: 'completed', provider: 'batch', commits: [],
      structuredOutput: { type: 'goal_complete', kind: kind === 'qa' ? 'qa' : 'task', result: 'PASS', summary: 'local success' } })),
    kill: vi.fn(async () => {}), captureOutput: vi.fn(async () => ''), captureSession: vi.fn(async () => undefined) };
  const agentProvider = { name: 'claude-code', capabilities: new Set<string>(), createExecution: vi.fn(async () => execution) };
  const sandbox = { id: 'sandbox', worktreePath: root, close: vi.fn(async () => {}) };
  const sandboxProvider = { name: 'local', create: vi.fn(async () => sandbox) };
  const plugins = new PluginRuntime();
  runtimes.push(plugins);
  const capture = (context: InitContext | LifecycleContext, next: Phase) => {
    currentPhase = next;
    if (context.signal) contexts.push(context.signal);
  };
  await plugins.activate({ id: 'cancellation-fixture', version: '1.0.0', setup(setup) {
    setup.registerContextProvider('local.context', { id: 'local.context', capabilities: { 'read-only': true, summarize: false, search: true },
      async gather(_query, options) { await block(options); return []; } });
    setup.registerVerificationProvider('local.verify', { id: 'local.verify', capabilities: { 'static-analysis': false, 'test-execution': false, 'custom-script': true },
      async verify(_request, options) {
        if (processHook === 'verification' && hang && currentPhase === phase) {
          providerSignals.push(options?.signal);
          entered.resolve();
          return commandProvider.verify({ target: root }, options);
        }
        await block(options); return { passed: true, durationMs: 0 };
      } });
    setup.registerNotificationProvider('local.notify', { id: 'local.notify', capabilities: { 'direct-message': true, 'channel-post': false, mention: false }, notify });
    setup.registerLifecycle({ name: 'phase-observer', order: -200, failureMode: 'required',
      async onInit(context) {
        capture(context, 'init');
        await invokeCapability(plugins, { capability: 'context.provider', provider: 'local.context', operation: 'gather', input: { scope: 'local', prompt: 'init' } }, { signal: context.signal });
      },
      async onBeforeAgent(context) { capture(context, 'before-agent'); },
      async onAfterAgent(context) { capture(context, 'after-agent'); },
      async onBeforePublish(context) { capture(context, 'before-publish'); },
      async onCleanup(context) { cleanupSignals.push(context.signal); },
    });
    setup.registerLifecycle(createCapabilityLifecycle(plugins, {
      contexts: [{ provider: 'local.context', query: () => ({ scope: 'local', prompt: 'before' }), consume: () => {} }],
      verifications: [{ provider: 'local.verify', request: () => ({ target: root, command: ['local'] }) }],
      notifications: [{ provider: 'local.notify', message: () => ({ title: 'complete', body: 'complete' }) }],
    }));
    registerVerificationSystemActions(plugins, setup, [{ name: 'local.verify-action', provider: 'local.verify', request: () => ({ target: root, command: ['local'] }) }]);
    setup.registerSystemAction('local.select-action', async () => { currentPhase = 'action'; });
    setup.registerWorkflowTemplate({ name: 'cancellation-local', version: 1, steps: [
      { id: 'implement', kind: 'agent', role: 'developer', prompt: 'Complete local task.' },
      ...(phase === 'action' ? [
        { id: 'select', kind: 'system' as const, action: 'local.select-action', dependsOn: ['implement'] },
        { id: 'check', kind: 'system' as const, action: 'local.verify-action', dependsOn: ['select'] },
      ] : []),
    ] });
  } });
  const config = { ...getWorkflowConfig(), workflowHardTimeout: 60_000, qaTimeout: 60_000, maxRetries: 0 };
  const repository = { primary: true, repoRoot: root, baseBranch: 'main', targetBranch: 'main', sourceBranch: 'feat/task',
    handle: { branch: 'feat/task', path: root, isNewBranch: false } };
  const prepareRepositories = { prepare: vi.fn(async () => ({ primary: repository, repositories: [repository],
    heartbeat: repositoryHeartbeat, finish: finishWorkspace, release: releaseWorkspace })) };
  const runtimeManager = { start: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}), finish: vi.fn(async (_runId: string, _outcome: { status: string; errorSummary?: string }) => {}) };
  const common = { plugins, agentProvider, sandboxProvider, config, projectRoot: root,
    ...(repositoryLease ? { repositories: [repository], multiRepositoryPreparer: prepareRepositories, prepareRepositories } : {}),
    runtimeManager };
  const observer = { record: vi.fn(async () => {}) };
  const runner = kind === 'workflow'
    ? new WorkflowRunner(providers as unknown as ProviderBundle, { ...common, observer, watchdog: { arm: vi.fn(), disarm: vi.fn() } } as never)
    : new QARunner(providers as unknown as ProviderBundle, config, common as never);
  const run = (options: ProviderOperationOptions = {}) => kind === 'workflow'
    ? (runner as WorkflowRunner).run({ backlogId: '42', session: 'cancellation-42', targetBranch: 'main', baseBranchExplicit: true,
      repoRoot: root, template: 'cancellation-local', ...(repositoryLease ? { repositories: [repository] } : {}), ...options } as RunnerOptions).catch(error => ({ success: false, summary: String(error), error }))
    : (runner as QARunner).process('42', options);
  return { runner, run, config, providers, heartbeat, release, commit, push, create, notify, execution, agentProvider, entered, gate, plugins, pidFile, sandbox, sandboxProvider, runtimeManager, observer,
    repositoryHeartbeat, prepareRepositories, finishWorkspace, releaseWorkspace,
    contexts, providerSignals, cleanupSignals, processExited, child: () => child, stopHanging: () => { hang = false; gate.resolve(); } };
}

describe.each<Kind>(['workflow', 'qa'])('%s hook cancellation', kind => {
  it.each<Phase>(['init', 'before-agent', 'after-agent', 'before-publish'])('aborts hanging %s with the trusted caller signal and cleans up', async phase => {
    const f = await fixture(kind, phase);
    const caller = new AbortController();
    const cause = new Error('trusted caller stopped this run');
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(Promise.race([f.entered.promise.then(() => 'entered'), pending]))).toBe('entered');
      const priorNotifications = f.notify.mock.calls.length;
      caller.abort(cause);
      const result = await bounded(pending);
      expect(result).not.toBe('still pending');
      expect(result).toMatchObject({ success: false, summary: expect.stringContaining(cause.message) });
      expect(f.contexts.length).toBeGreaterThan(0);
      expect(f.providerSignals.every(signal => signal === f.contexts[0])).toBe(true);
      expect(f.contexts[0].reason).toBe(cause);
      expect(f.cleanupSignals).toHaveLength(1);
      expect(f.cleanupSignals[0]).toBeDefined();
      expect(f.cleanupSignals[0]?.aborted).toBe(false);
      f.stopHanging();
      await delay(20);
      expect(f.push).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.notify).toHaveBeenCalledTimes(priorNotifications);
      if (phase === 'init' || phase === 'before-agent') expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
    } finally { f.stopHanging(); await pending; }
  });

  it('enforces the total deadline before an agent exists', async () => {
    const f = await fixture(kind, 'before-agent');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const pending = f.run();
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await bounded(pending)).toMatchObject({ success: false, summary: expect.stringMatching(/timeout|deadline/i) });
      expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(f.cleanupSignals).toHaveLength(1);
    } finally { f.stopHanging(); await pending; }
  });

  it('aborts an init hook on lease loss before an agent exists', async () => {
    const f = await fixture(kind, 'init');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const pending = f.run();
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      if (kind === 'workflow') f.heartbeat.mockRejectedValueOnce(new Error('claim ownership lost'));
      else f.providers.backlog.get.mockRejectedValueOnce(new Error('QA repository lease lost'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await bounded(pending)).toMatchObject({ success: false, summary: expect.stringContaining('lost') });
      expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(f.cleanupSignals).toHaveLength(1);
    } finally { f.stopHanging(); await pending; }
  });

  it('physically stops the provider-owned local Node process', async () => {
    const f = await fixture(kind, 'before-agent', true);
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      caller.abort(new Error('kill local hook'));
      expect(await bounded(pending)).toMatchObject({ success: false });
      expect(f.child()!.signalCode).toBe('SIGKILL');
      expect(await bounded(f.processExited.promise)).not.toBe('still pending');
      expect(() => process.kill(f.child()!.pid!, 0)).toThrow();
    } finally { f.stopHanging(); await pending; }
  });

  it('waits for the real verification command process to close before returning', async () => {
    const f = await fixture(kind, 'after-agent', 'verification');
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    let pid: number | undefined;
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      for (let attempt = 0; attempt < 100 && pid === undefined; attempt++) {
        try { pid = Number(await readFile(f.pidFile, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await delay(10); }
      }
      expect(pid).toBeGreaterThan(0);
      process.kill(pid!, 0);
      caller.abort(new Error('close real verification process'));
      expect(await bounded(pending)).toMatchObject({ success: false, summary: expect.stringContaining('close real verification process') });
      expect(() => process.kill(pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
      expect(f.cleanupSignals).toHaveLength(1);
      expect(f.push).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
    } finally { caller.abort(); f.stopHanging(); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } await pending; }
  });

  it('waits for the owned Agent Node process to exit after kill', async () => {
    const f = await fixture(kind, 'before-agent');
    f.stopHanging();
    const ready = deferred<void>();
    const exited = deferred<void>();
    let child: ChildProcess | undefined;
    const original = f.execution.waitForResult.getMockImplementation()!;
    f.agentProvider.createExecution.mockImplementationOnce(async () => {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(child);
      child.once('exit', () => exited.resolve());
      child.stdout!.once('data', () => ready.resolve());
      await ready.promise;
      return f.execution;
    });
    f.execution.waitForResult.mockImplementationOnce(async () => { await exited.promise; return original(); });
    f.execution.kill.mockImplementation(async () => { child?.kill('SIGKILL'); if (child) await exited.promise; });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(ready.promise)).not.toBe('still pending');
      caller.abort(new Error('stop owned Agent process'));
      expect(await bounded(pending)).toMatchObject({ success: false });
      expect(child?.signalCode).toBe('SIGKILL');
      expect(() => process.kill(child!.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
    } finally { caller.abort(); child?.kill('SIGKILL'); await pending; }
  });

  it('gives the next invocation a fresh signal after cancellation', async () => {
    const f = await fixture(kind, 'before-agent');
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      caller.abort(new Error('first run only'));
      expect(await bounded(pending)).toMatchObject({ success: false });
      const old = f.contexts[0];
      f.stopHanging();
      f.contexts.length = 0;
      expect(await bounded(f.run())).toMatchObject({ success: true });
      expect(f.contexts[0]).not.toBe(old);
      expect(f.contexts[0].aborted).toBe(false);
    } finally { f.stopHanging(); await pending; }
  });

  it('cancels a before-agent hook on repository lease loss', async () => {
    const f = await fixture(kind, 'before-agent', false, true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const pending = f.run();
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      const cause = new Error('repository ownership lost');
      f.repositoryHeartbeat.mockRejectedValueOnce(cause);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await bounded(pending)).toMatchObject({ success: false, summary: expect.stringContaining(cause.message) });
      expect(f.contexts[0].reason).toBe(cause);
      expect(f.finishWorkspace).toHaveBeenCalledWith({ status: 'failed' });
      expect(f.push).not.toHaveBeenCalled();
    } finally { f.stopHanging(); await pending; }
  });

  it('retains responsibility for a workspace that returns after cancellation', async () => {
    const f = await fixture(kind, 'before-agent', false, true);
    f.stopHanging();
    const acquired = deferred<void>();
    const original = f.prepareRepositories.prepare.getMockImplementation()!;
    const prepareEntered = deferred<void>();
    f.prepareRepositories.prepare.mockImplementationOnce(async () => { prepareEntered.resolve(); await acquired.promise; return original(); });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(prepareEntered.promise)).not.toBe('still pending');
      caller.abort(new Error('cancel while preparing'));
      expect(await Promise.race([pending, delay(20, 'waiting for ownership')])).toBe('waiting for ownership');
      acquired.resolve();
      expect(await bounded(pending)).toMatchObject({ success: false });
      expect(f.finishWorkspace).toHaveBeenCalledWith({ status: 'failed' });
      expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
    } finally { acquired.resolve(); await pending; }
  });

  it('kills the active agent and rejects a late PASS without publishing', async () => {
    const f = await fixture(kind, 'before-agent');
    f.stopHanging();
    const started = deferred<void>();
    const completed = deferred<void>();
    const original = f.execution.waitForResult.getMockImplementation()!;
    f.execution.waitForResult.mockImplementationOnce(async () => { started.resolve(); await completed.promise; return original(); });
    f.execution.kill.mockImplementation(async () => { completed.resolve(); });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(started.promise)).not.toBe('still pending');
      caller.abort(new Error('agent must stop'));
      expect(await bounded(pending)).toMatchObject({ success: false, summary: expect.stringContaining('agent must stop') });
      expect(f.execution.kill).toHaveBeenCalled();
      completed.resolve();
      await delay(20);
      expect(f.push).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
    } finally { completed.resolve(); await pending; }
  });

  it('waits for cleanup to settle before returning a cancelled run', async () => {
    const f = await fixture(kind, 'before-agent');
    const cleanupStarted = deferred<void>();
    const cleanupFinished = deferred<void>();
    await f.plugins.activate({ id: 'owned-cleanup', version: '1.0.0', setup(setup) {
      setup.registerLifecycle({ name: 'owned-cleanup', async onCleanup(context) {
        expect(context.signal?.aborted).toBe(false);
        cleanupStarted.resolve();
        await cleanupFinished.promise;
      } });
    } });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      caller.abort(new Error('cancel and clean up'));
      expect(await bounded(cleanupStarted.promise)).not.toBe('still pending');
      expect(await Promise.race([pending, delay(20, 'waiting for cleanup')])).toBe('waiting for cleanup');
      cleanupFinished.resolve();
      expect(await bounded(pending)).toMatchObject({ success: false });
    } finally { f.stopHanging(); cleanupFinished.resolve(); await pending; }
  });

  it('waits for cooperative provider cleanup and rejects its late PASS', async () => {
    const f = await fixture(kind, 'before-agent');
    const entered = deferred<void>();
    const abortSeen = deferred<void>();
    const providerClosed = deferred<void>();
    await f.plugins.activate({ id: 'slow-close', version: '1.0.0', setup(setup) {
      setup.registerContextProvider('slow-close', { id: 'slow-close', capabilities: { 'read-only': true, summarize: false, search: true },
        async gather(_query, options) {
          entered.resolve();
          options?.signal?.addEventListener('abort', () => abortSeen.resolve(), { once: true });
          await providerClosed.promise;
          return [];
        } });
      setup.registerLifecycle({ name: 'slow-close', order: -300, failureMode: 'required', async onBeforeAgent(context) {
        await invokeCapability(f.plugins, { capability: 'context.provider', provider: 'slow-close', operation: 'gather',
          input: { scope: 'local', prompt: 'wait for close' } }, { signal: context.signal });
      } });
    } });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(entered.promise)).not.toBe('still pending');
      caller.abort(new Error('provider must finish cleanup'));
      expect(await bounded(abortSeen.promise)).not.toBe('still pending');
      expect(await Promise.race([pending, delay(20, 'waiting for provider close')])).toBe('waiting for provider close');
      expect(f.cleanupSignals).toHaveLength(0);
      providerClosed.resolve();
      expect(await bounded(pending)).toMatchObject({ success: false, summary: expect.stringContaining('provider must finish cleanup') });
      expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
    } finally { f.stopHanging(); providerClosed.resolve(); await pending; }
  });

  it('gives cleanup its own cooperative 15 second deadline', async () => {
    const f = await fixture(kind, 'before-agent');
    const entered = deferred<void>();
    const releaseCleanup = deferred<void>();
    let cleanupSignal: ProviderAbortSignal | undefined;
    await f.plugins.activate({ id: 'cleanup-deadline', version: '1.0.0', setup(setup) {
      setup.registerLifecycle({ name: 'cleanup-deadline', order: 300, async onCleanup(context) {
        cleanupSignal = context.signal;
        entered.resolve();
        await new Promise<void>(resolve => {
          context.signal?.addEventListener('abort', resolve, { once: true });
          void releaseCleanup.promise.then(resolve);
        });
      } });
    } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal });
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      caller.abort(new Error('caller cancelled'));
      expect(await bounded(entered.promise)).not.toBe('still pending');
      expect(cleanupSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(cleanupSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(cleanupSignal?.aborted).toBe(true);
      expect(cleanupSignal?.reason).toEqual(new Error('Lifecycle cleanup timed out'));
      expect(await bounded(pending)).toMatchObject({ success: false, summary: expect.stringContaining('caller cancelled') });
    } finally { f.stopHanging(); releaseCleanup.resolve(); await vi.advanceTimersByTimeAsync(15_000); await pending; }
  });

  it('ignores the old timer and a late heartbeat rejection during the next run', async () => {
    const f = await fixture(kind, 'before-agent', false, true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const heartbeatStarted = deferred<void>();
    const oldHeartbeat = deferred<void>();
    const rejectOldHeartbeat = new Error('old heartbeat failure');
    const heartbeat = async () => { heartbeatStarted.resolve(); await oldHeartbeat.promise; throw rejectOldHeartbeat; };
    f.repositoryHeartbeat.mockImplementationOnce(heartbeat);
    const caller = new AbortController();
    const first = f.run({ signal: caller.signal });
    const nextEntered = deferred<void>();
    const nextGate = deferred<void>();
    let nextSignal: ProviderAbortSignal | undefined;
    let second: ReturnType<typeof f.run> | undefined;
    try {
      expect(await bounded(f.entered.promise)).not.toBe('still pending');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await bounded(heartbeatStarted.promise)).not.toBe('still pending');
      caller.abort(new Error('first invocation only'));
      expect(await bounded(first)).toMatchObject({ success: false });
      f.stopHanging();
      f.config.workflowHardTimeout = 120_000;
      f.config.qaTimeout = 120_000;
      await f.plugins.activate({ id: 'next-pause', version: '1.0.0', setup(setup) {
        setup.registerLifecycle({ name: 'next-pause', order: -300, async onBeforeAgent(context) {
          nextSignal = context.signal; nextEntered.resolve(); await nextGate.promise;
        } });
      } });
      second = f.run();
      expect(await bounded(nextEntered.promise)).not.toBe('still pending');
      oldHeartbeat.resolve();
      await vi.advanceTimersByTimeAsync(50_001);
      expect(nextSignal?.aborted).toBe(false);
      vi.useRealTimers();
      nextGate.resolve();
      expect(await bounded(second)).toMatchObject({ success: true });
    } finally { f.stopHanging(); oldHeartbeat.resolve(); nextGate.resolve(); await first; await second; }
  });

  it('does not acquire ownership for an already aborted caller', async () => {
    const f = await fixture(kind, 'before-agent');
    f.stopHanging();
    const caller = new AbortController();
    caller.abort(new Error('already cancelled'));
    expect(await f.run({ signal: caller.signal })).toMatchObject({ success: false, summary: expect.stringContaining('already cancelled') });
    expect(f.providers.backlog.get).not.toHaveBeenCalled();
    expect(f.providers.backlog.claim).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejects invalid total deadline %s before acquiring ownership', async timeout => {
    const f = await fixture(kind, 'before-agent');
    f.stopHanging();
    f.config.workflowHardTimeout = timeout;
    f.config.qaTimeout = timeout;
    await expect(f.run().catch(error => ({ success: false, summary: String(error) }))).resolves.toMatchObject({
      success: false, summary: expect.stringMatching(/positive integer.*2147483647/),
    });
    expect(f.providers.backlog.get).not.toHaveBeenCalled();
    expect(f.providers.backlog.claim).not.toHaveBeenCalled();
  });
});

it('releases a late claim without starting another operation', async () => {
  const f = await fixture('workflow', 'before-agent');
  const gate = deferred<void>();
  const entered = deferred<void>();
  const original = f.providers.backlog.claim.getMockImplementation()!;
  f.providers.backlog.claim.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return original(); });
  const caller = new AbortController();
  const pending = f.run({ signal: caller.signal });
  try {
    await entered.promise;
    caller.abort(new Error('cancel claim acquisition'));
    expect(await Promise.race([pending, delay(20, 'waiting for claim')])).toBe('waiting for claim');
    gate.resolve();
    expect(await bounded(pending)).toMatchObject({ success: false });
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.providers.branches.createBranch).not.toHaveBeenCalled();
    expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
  } finally { f.stopHanging(); gate.resolve(); await pending; }
});

describe.each(['late-cancel', 'rework', 'run.started', 'lease.granted'] as const)('early claim ownership at %s', stage => {
  it.each([false, true])('preserves the original failure and retryable original owner (release EIO: %s)', async releaseFails => {
    const f = await fixture('workflow', 'before-agent');
    f.stopHanging();
    const storeRoot = join(f.sandbox.worktreePath, 'early-claim-state');
    const store = new FilesystemClaimLock(storeRoot);
    const key = 'early/claim/42';
    const lease = (await store.acquire({ key, owner: 'original', ttlMs: 60_000 }))!;
    const release = vi.fn(lease.release);
    const original = new Error(`early ${stage} failed`);
    const entered = deferred<void>(), go = deferred<void>(), caller = new AbortController();
    let pending: Promise<unknown> | undefined;
    let retained: RunResourceScope | undefined;
    let successor: ClaimLease | undefined;
    f.providers.backlog.claim.mockImplementationOnce(async () => {
      if (stage === 'late-cancel') { entered.resolve(); await go.promise; }
      return { item: await f.providers.backlog.get(), heartbeat: vi.fn(lease.heartbeat), release };
    });
    if (stage === 'rework') f.providers.backlog.getActiveRework.mockRejectedValueOnce(original);
    if (stage === 'run.started' || stage === 'lease.granted') {
      f.observer.record.mockResolvedValueOnce(undefined);
      if (stage === 'lease.granted') f.observer.record.mockResolvedValueOnce(undefined);
      f.observer.record.mockRejectedValueOnce(original);
    }
    try {
      earlyClaimIo.target = join(storeRoot, 'claims', key, 'lock');
      earlyClaimIo.remaining = releaseFails ? 1 : 0;
      earlyClaimIo.errors = [];
      pending = f.run({ signal: caller.signal });
      if (stage === 'late-cancel') { await entered.promise; caller.abort(original); go.resolve(); }
      const result = await pending as { success: boolean; error: Error & { errors?: unknown[]; cause?: { runError: unknown; recovery: { scope: RunResourceScope } } } };
      expect(result.success).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
      const runError = releaseFails ? result.error.cause?.runError : result.error;
      if (stage === 'run.started' || stage === 'lease.granted') {
        expect(runError).toBeInstanceOf(AuditPersistenceError);
        expect(runError).toMatchObject({ cause: original });
      } else expect(runError).toBe(original);
      if (releaseFails) {
        expect(result.error).toBeInstanceOf(AggregateError);
        expect(result.error.errors).toEqual([runError, earlyClaimIo.errors[0]]);
        retained = result.error.cause!.recovery.scope;
        expect(retained).toBeDefined();
        expect((await store.inspect(key))?.claimId).toBe(lease.claimId);
        expect(await store.acquire({ key, owner: 'blocked', ttlMs: 60_000 })).toBeNull();
        const nextRelease = vi.fn(async () => {}), nextError = new Error('next invocation rework failed');
        f.providers.backlog.claim.mockResolvedValueOnce({ item: await f.providers.backlog.get(), release: nextRelease, heartbeat: vi.fn(async () => {}) });
        f.providers.backlog.getActiveRework.mockRejectedValueOnce(nextError);
        expect(await f.run()).toMatchObject({ success: false, error: nextError });
        expect(nextRelease).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        await retained.finish({ status: 'failed' });
        expect(release).toHaveBeenCalledTimes(2);
      }
      expect(await store.inspect(key)).toBeNull();
      successor = (await store.acquire({ key, owner: 'successor', ttlMs: 60_000 }))!;
      expect(successor).not.toBeNull();
      await retained?.finish({ status: 'failed' });
      expect((await store.inspect(key))?.claimId).toBe(successor.claimId);
      expect(release).toHaveBeenCalledTimes(releaseFails ? 2 : 1);
    } finally {
      earlyClaimIo.remaining = 0;
      earlyClaimIo.target = '';
      go.resolve(); caller.abort(); await pending;
      await retained?.finish({ status: 'failed' });
      await lease.release(); await successor?.release();
    }
  });
});

it('passes the owned workflow signal through a plugin system action', async () => {
  const f = await fixture('workflow', 'action');
  const caller = new AbortController();
  const pending = f.run({ signal: caller.signal });
  try {
    expect(await bounded(f.entered.promise)).not.toBe('still pending');
    caller.abort(new Error('system action cancelled'));
    expect(await bounded(pending)).toMatchObject({ success: false });
    expect(f.providerSignals.at(-1)).toBe(f.contexts[0]);
    expect(f.push).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  } finally { f.stopHanging(); await pending; }
});

describe.each<Kind>(['workflow', 'qa'])('%s terminal resource cleanup', kind => {
  it.each([false, true])('exposes actual owned Node kill failure without claiming completed (killFails=%s)', async killFails => {
    const f = await fixture(kind, 'before-agent');
    f.stopHanging();
    const exited = deferred<void>();
    const ready = deferred<void>();
    let child: ChildProcess | undefined;
    const failure = new Error('SPEC_OWNED_PROCESS_KILL_FAILED');
    f.agentProvider.createExecution.mockImplementationOnce(async () => {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(child);
      child.once('exit', () => exited.resolve());
      child.stdout!.once('data', () => ready.resolve());
      await ready.promise;
      return f.execution;
    });
    f.execution.kill.mockImplementation(async () => {
      if (killFails) throw failure;
      if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.promise; }
    });
    try {
      const result = await f.run().catch(error => ({ success: false, error }));
      expect(result).toMatchObject({ success: !killFails });
      expect(f.runtimeManager.finish.mock.calls.at(-1)?.[1]).toMatchObject({ status: killFails ? 'blocked' : 'completed' });
      if (killFails) {
        expect(() => process.kill(child!.pid!, 0)).not.toThrow();
        expect(f.runtimeManager.finish.mock.calls.at(-1)?.[1].errorSummary).toContain(failure.message);
        expect(result).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining(failure.message) }) });
        if (kind === 'qa') {
          expect(result).toMatchObject({ error: expect.objectContaining({ cause: expect.objectContaining({
            publication: expect.objectContaining({ url: 'https://example.test/42' }),
            recovery: expect.objectContaining({ execution: f.execution, sandbox: f.sandbox }),
          }) }) });
          expect(f.providers.branches.cleanup).not.toHaveBeenCalled();
          expect(f.create).toHaveBeenCalledTimes(1);
        } else {
          expect(f.release).not.toHaveBeenCalled();
          expect(result).toMatchObject({ error: expect.objectContaining({ cause: expect.objectContaining({ implementationHandedOff: true }) }) });
        }
        const failureResult = result as { error: { cause: { recovery: { scope: RunResourceScope } } } };
        const retained = failureResult.error.cause.recovery.scope;
        expect(retained.hasUnclosedExecutions).toBe(true);
        expect(retained.ownershipClaims.length).toBeGreaterThan(0);
        f.execution.kill.mockImplementation(async () => {
          if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.promise; }
        });
        await retained.finish({ status: 'failed' });
        expect(() => process.kill(child!.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
        expect(retained.ownershipClaims).toHaveLength(0);
        if (kind === 'workflow') expect(f.release).toHaveBeenCalledTimes(1);
        else expect(f.providers.branches.cleanup).toHaveBeenCalledWith(f.sandbox.worktreePath, { preserve: true });
      } else expect(() => process.kill(child!.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
      expect(f.push).toHaveBeenCalledTimes(1);
      expect(f.sandbox.close).toHaveBeenCalled();
      expect(f.cleanupSignals).toHaveLength(1);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.promise; }
    }
  });
});

it.each(['sandbox', 'lifecycle', 'worktree', 'workspace'])('QA continues independent terminal cleanup after %s fails', async resource => {
  const f = await fixture('qa', 'before-agent', false, true);
  f.stopHanging();
  const failure = new Error(`owned ${resource} cleanup failed`);
  const cleanup = vi.fn(async () => { if (resource === 'lifecycle') throw failure; });
  await f.plugins.activate({ id: 'cleanup-failure', version: '1.0.0', setup(setup) {
    setup.registerLifecycle({ name: 'cleanup-failure', onCleanup: cleanup });
  } });
  if (resource === 'lifecycle') {
    const dispatch = LifecycleDispatcher.prototype.run;
    vi.spyOn(LifecycleDispatcher.prototype, 'run').mockImplementation(async function(this: LifecycleDispatcher, phase, context) {
      await dispatch.call(this, phase, context);
      if (phase === 'cleanup') throw failure;
    });
  }
  if (resource === 'sandbox') f.sandbox.close.mockRejectedValueOnce(failure);
  if (resource === 'worktree') f.providers.branches.cleanup.mockRejectedValueOnce(failure);
  if (resource === 'workspace') f.releaseWorkspace.mockRejectedValueOnce(failure);
  const result = await f.run().catch(error => ({ success: false, error }));
  expect(result).toMatchObject({ success: false, error: expect.objectContaining({ message: expect.stringContaining(failure.message) }) });
  expect(f.sandbox.close).toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalled();
  expect(f.providers.branches.cleanup).toHaveBeenCalled();
  const deferredWorkspace = resource === 'sandbox' || resource === 'worktree';
  expect(f.releaseWorkspace.mock.calls.length + f.finishWorkspace.mock.calls.length).toBe(deferredWorkspace ? 0 : 1);
  expect(f.runtimeManager.finish).toHaveBeenCalled();
  if (deferredWorkspace) {
    const retained = (result as { error: { cause: { recovery: { scope: RunResourceScope } } } }).error.cause.recovery.scope;
    expect(retained.ownershipClaims.length).toBeGreaterThan(0);
    await retained.finish({ status: 'failed' });
    expect(f.finishWorkspace).toHaveBeenCalledTimes(1);
    expect(retained.ownershipClaims).toHaveLength(0);
  }
});

it('retains the earlier cancellation cause alongside terminal resource failure', async () => {
  const f = await fixture('qa', 'after-agent');
  const caller = new AbortController();
  const failure = new Error('terminal stop failed');
  const pending = f.run({ signal: caller.signal }).catch(error => ({ success: false, error }));
  try {
    expect(await bounded(f.entered.promise)).not.toBe('still pending');
    f.execution.kill.mockRejectedValue(failure);
    caller.abort(new Error('trusted original cancellation'));
    const result = await bounded(pending);
    expect(result).toMatchObject({ success: false, error: expect.objectContaining({
      message: expect.stringContaining('trusted original cancellation'),
      cause: expect.objectContaining({ runError: caller.signal.reason }),
    }) });
    expect(f.runtimeManager.finish.mock.calls.at(-1)?.[1].errorSummary).toContain(failure.message);
    expect(f.cleanupSignals).toHaveLength(1);
    expect(f.create).not.toHaveBeenCalled();
  } finally { f.stopHanging(); await pending; }
});

it('QA retains conflict sandbox ownership when its local close fails', async () => {
  const f = await fixture('qa', 'before-agent');
  f.stopHanging();
  const failure = new Error('conflict sandbox close failed');
  const conflictSandbox = { ...f.sandbox, id: 'conflict-sandbox', close: vi.fn(async (): Promise<void> => { throw failure; }) };
  f.providers.branches.mergeFeatureIntoBaseline.mockResolvedValue({ merged: false, conflicts: ['tracked'] } as never);
  Object.assign(f.providers.branches, { listUnresolvedConflicts: vi.fn(async () => []) });
  f.sandboxProvider.create.mockResolvedValueOnce(f.sandbox).mockResolvedValueOnce(conflictSandbox);
  const result = await f.run().catch(error => ({ success: false, error }));
  expect(result).toMatchObject({ success: false, error: expect.objectContaining({ message: expect.stringContaining(failure.message) }) });
  expect(conflictSandbox.close.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(f.sandbox.close).toHaveBeenCalled();
  expect(f.cleanupSignals).toHaveLength(1);
  expect(f.providers.branches.cleanup).toHaveBeenCalled();
  expect(f.runtimeManager.finish.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'blocked', errorSummary: expect.stringContaining(failure.message) });
});

it('Workflow cleanup retry retains its original workspace after another invocation resets the runner', async () => {
  const f = await fixture('workflow', 'before-agent', false, true);
  f.stopHanging();
  f.execution.kill.mockRejectedValue(new Error('owner-42 not stopped'));
  const first = await f.run() as { error: { cause: { recovery: { scope: RunResourceScope } } } };
  const retained = first.error.cause.recovery.scope;
  expect(retained.hasUnclosedExecutions).toBe(true);
  expect(f.finishWorkspace).not.toHaveBeenCalled();
  const nextRelease = vi.fn(async () => {});
  f.providers.backlog.claim.mockResolvedValueOnce({ item: { ...await f.providers.backlog.get(), id: '43' }, heartbeat: vi.fn(async () => {}), release: nextRelease });
  await expect((f.runner as WorkflowRunner).run({ backlogId: '43', session: 'next-owner', targetBranch: 'main', baseBranchExplicit: true,
    repoRoot: f.sandbox.worktreePath, template: 'cancellation-local' })).rejects.toThrow('quarantined');
  expect(nextRelease).toHaveBeenCalledTimes(1);
  expect(f.release).not.toHaveBeenCalled();
  f.execution.kill.mockResolvedValue();
  await retained.finish({ status: 'failed' });
  expect(f.finishWorkspace).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(retained.ownershipClaims).toHaveLength(0);
});

it('Workflow retries an unconfirmed prepared workspace without caching its rejection or relinquishing the claim', async () => {
  const f = await fixture('workflow', 'before-agent', false, true);
  f.stopHanging();
  const failure = new Error('prepared workspace cleanup unconfirmed');
  f.finishWorkspace.mockRejectedValue(failure);
  const result = await f.run() as { error: { cause: { recovery: { scope: RunResourceScope } } } };
  const retained = result.error.cause.recovery.scope;
  expect(retained.ownershipClaims.length).toBeGreaterThan(0);
  expect(f.release).not.toHaveBeenCalled();
  const failedCalls = f.finishWorkspace.mock.calls.length;
  f.finishWorkspace.mockResolvedValue();
  await retained.finish({ status: 'failed' });
  expect(f.finishWorkspace).toHaveBeenCalledTimes(failedCalls + 1);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(retained.ownershipClaims).toHaveLength(0);
});

it('Workflow retains a failed primary worktree cleanup for the original scope retry', async () => {
  const f = await fixture('workflow', 'before-agent');
  f.stopHanging();
  const failure = new Error('primary worktree cleanup unconfirmed');
  f.providers.branches.cleanup.mockRejectedValue(failure);
  const result = await f.run();
  expect(result).toMatchObject({ success: false, error: expect.objectContaining({ message: expect.stringContaining(failure.message) }) });
  const retained = (result as { error: { cause: { recovery: { scope: RunResourceScope } } } }).error.cause.recovery.scope;
  expect(retained.ownershipClaims.length).toBeGreaterThan(0);
  expect(f.release).not.toHaveBeenCalled();
  f.providers.branches.cleanup.mockResolvedValue(undefined);
  const failedCalls = f.providers.branches.cleanup.mock.calls.length;
  await retained.finish({ status: 'failed' });
  expect(f.providers.branches.cleanup).toHaveBeenCalledTimes(failedCalls + 1);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(retained.ownershipClaims).toHaveLength(0);
});
