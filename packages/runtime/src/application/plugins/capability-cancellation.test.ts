import { describe, expect, it } from 'vitest';
import type { ProviderOperationOptions, RepositoryProvider, VerificationProvider } from '../../plugin-sdk/capabilities.js';
import { LifecycleDispatcher, type LifecycleContext } from '../workflows/lifecycle.js';
import { SystemActionExecutor } from '../workflows/system-actions.js';
import { createCapabilityLifecycle, registerVerificationSystemActions } from './integrations.js';
import { invokeCapability } from './operations.js';
import { PluginRuntime } from './runtime.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TestRunnerVerificationProvider } from '../../infrastructure/verification/index.js';
import { createDefaultPluginRuntime } from './default-runtime.js';

const context: LifecycleContext = { iid: 1, worktreePath: '/workspace', baseBranch: 'main', sessionName: 'test', params: {} };
const invocation = { capability: 'verification.provider', provider: 'check', operation: 'verify', input: { target: '/workspace' } };

async function fixture(verify: VerificationProvider['verify']) {
  const runtime = new PluginRuntime();
  await runtime.activate({
    manifest: { id: 'verification.cancel-test', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['verification.provider', 'workflow.action'] },
    activate(setup) {
      setup.registerVerificationProvider('check', { id: 'check', capabilities: { 'static-analysis': false, 'test-execution': true, 'custom-script': false }, verify });
      registerVerificationSystemActions(runtime, setup, [{ name: 'check', provider: 'check', request: () => ({ target: '/workspace' }) }]);
    },
  });
  return runtime;
}

describe('trusted provider cancellation', () => {
  it('does not start an already cancelled capability operation', async () => {
    let calls = 0;
    const runtime = await fixture(async () => { calls++; return { passed: true, durationMs: 1 }; });
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    controller.abort(reason);
    try {
      await expect(invokeCapability(runtime, invocation, { signal: controller.signal })).rejects.toBe(reason);
      expect(calls).toBe(0);
    } finally { await runtime.close(); }
  });

  it('forwards the exact trusted signal and rejects a late successful result', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during check');
    let observed: ProviderOperationOptions | undefined;
    const runtime = await fixture(async (_request, options) => {
      observed = options;
      controller.abort(reason);
      return { passed: true, durationMs: 1 };
    });
    try {
      await expect(invokeCapability(runtime, invocation, { signal: controller.signal })).rejects.toBe(reason);
      expect(observed?.signal).toBe(controller.signal);
    } finally { await runtime.close(); }
  });

  it('does not accept a signal in the public JSON invocation', async () => {
    const runtime = await fixture(async () => ({ passed: true, durationMs: 1 }));
    try {
      await expect(invokeCapability(runtime, { ...invocation, signal: new AbortController().signal })).rejects.toThrow('Invalid or unsupported');
      await expect(invokeCapability(runtime, { ...invocation, input: { ...invocation.input, signal: {} } })).rejects.toThrow('Invalid or unsupported');
    } finally { await runtime.close(); }
  });

  it('waits for an aborted provider to settle before returning cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel pending');
    let release!: () => void;
    let started!: () => void;
    let observed: ProviderOperationOptions | undefined;
    let observedAbort = false;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const runtime = await fixture((_request, options) => {
      observed = options;
      started();
      return new Promise(resolve => {
        const abort = () => { observedAbort = true; };
        options?.signal?.addEventListener('abort', abort, { once: true });
        release = () => {
          options?.signal?.removeEventListener('abort', abort);
          resolve({ passed: true, durationMs: 1 });
        };
      });
    });
    const operation = invokeCapability(runtime, invocation, { signal: controller.signal });
    void operation.catch(() => undefined);
    try {
      await ready;
      expect(observed?.signal).toBe(controller.signal);
      controller.abort(reason);
      expect(observedAbort).toBe(true);
      let settled = false;
      void operation.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await expect(operation).rejects.toBe(reason);
    } finally {
      release?.();
      await operation.catch(() => undefined);
      await runtime.close();
    }
  }, 1000);

  it('carries cancellation through runtime and the verification system action', async () => {
    const controller = new AbortController();
    const reason = new Error('system check stopped');
    let observed: ProviderOperationOptions | undefined;
    const runtime = await fixture(async (_request, options) => { observed = options; controller.abort(reason); return { passed: true, durationMs: 1 }; });
    try {
      await expect(new SystemActionExecutor({ plugins: runtime, publishChange: async () => {}, queueQA: async () => {} })
        .execute('check', {}, { signal: controller.signal })).rejects.toBe(reason);
      expect(observed?.signal).toBe(controller.signal);
    } finally { await runtime.close(); }
  });

  it('blocks publication and notification after lifecycle verification is cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('verification cancelled');
    let publication = 0;
    let notification = 0;
    const runtime = await fixture(async () => { controller.abort(reason); return { passed: true, durationMs: 1 }; });
    const lifecycle = createCapabilityLifecycle(runtime, {
      verifications: [{ provider: 'check', request: () => ({ target: '/workspace' }) }],
      artifacts: [{ provider: 'never', artifact: () => { publication++; return { name: 'x', mediaType: 'text/plain', bytes: new Uint8Array() }; }, publish: () => {} }],
      notifications: [{ provider: 'never', message: () => { notification++; return { title: 'x', body: '' }; } }],
    });
    try {
      await expect(new LifecycleDispatcher([lifecycle]).run('after-agent', { ...context, signal: controller.signal })).rejects.toBe(reason);
      expect(publication).toBe(0);
      expect(notification).toBe(0);
    } finally { await runtime.close(); }
  });

  it('does not swallow cancellation in an optional hook and uses a fresh cleanup signal', async () => {
    const controller = new AbortController();
    const reason = new Error('optional hook cancelled');
    const calls: string[] = [];
    const dispatcher = new LifecycleDispatcher([
      { name: 'first', onBeforeAgent: async () => { calls.push('first'); controller.abort(reason); }, onCleanup: async ctx => {
        expect(ctx.signal).toBeDefined();
        expect(ctx.signal).not.toBe(controller.signal);
        expect(ctx.signal?.aborted).toBe(false);
        calls.push('cleanup');
      } },
      { name: 'later', onBeforeAgent: async () => { calls.push('later'); } },
    ]);
    await expect(dispatcher.run('before-agent', { ...context, signal: controller.signal })).rejects.toBe(reason);
    await dispatcher.run('cleanup', { ...context, signal: controller.signal });
    expect(calls).toEqual(['first', 'cleanup']);
  });

  it('waits for the actual verification child to exit before cancellation returns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capability-owned-child-'));
    const pidFile = join(directory, 'child.pid');
    const controller = new AbortController();
    const reason = new Error('stop owned child');
    const provider = new TestRunnerVerificationProvider({ command: [process.execPath, '-e',
      'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', pidFile] });
    const runtime = await fixture((request, options) => provider.verify(request, options));
    const operation = invokeCapability(runtime, { ...invocation, input: { target: directory, timeoutMs: 5000 } }, { signal: controller.signal });
    void operation.catch(() => undefined);
    try {
      let pid = 0;
      for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        const bytes = await readFile(pidFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        pid = Number(bytes);
        if (!pid) await delay(10);
      }
      expect(pid).toBeGreaterThan(0);
      controller.abort(reason);
      await expect(operation).rejects.toBe(reason);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort(reason);
      await operation.catch(() => undefined);
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 7000);

  it('preserves a late allocated workspace handle so its caller can retain ownership', async () => {
    const controller = new AbortController();
    const workspace = { id: 'owned', repository: { url: 'fixture' }, runId: 'run', snapshot: { commit: 'a', branch: 'main', dirty: false } };
    const provider: RepositoryProvider = { id: 'repo', capabilities: { read: true, clone: true, push: false, prepare: true },
      snapshot: async () => workspace.snapshot,
      prepare: async (_request, options) => {
        expect(options?.signal).toBe(controller.signal);
        controller.abort(new Error('cancelled after allocation'));
        return workspace;
      } };
    const runtime = new PluginRuntime();
    await runtime.activate({ manifest: { id: 'repository.owned-test', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['repository.provider'] },
      activate: setup => setup.registerRepositoryProvider('repo', provider) });
    try {
      expect(await invokeCapability(runtime, { capability: 'repository.provider', provider: 'repo', operation: 'prepare', input: { repository: { url: 'fixture' }, runId: 'run' } }, { signal: controller.signal })).toEqual(workspace);
    } finally { await runtime.close(); }
  });

  it('forwards the trusted signal through the configured capability.invoke action', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capability-default-action-'));
    const runtime = await createDefaultPluginRuntime({ homeDir: directory, workspaceRoot: directory });
    const controller = new AbortController();
    const reason = new Error('configured action cancelled');
    let observed: ProviderOperationOptions | undefined;
    try {
      await runtime.activate({ manifest: { id: 'verification.configured-cancel', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['verification.provider'] },
        activate(setup) { setup.registerVerificationProvider('check', { id: 'check', capabilities: { 'static-analysis': false, 'test-execution': true, 'custom-script': false },
          async verify(_request, options) { observed = options; controller.abort(reason); return { passed: true, durationMs: 0 }; } }); } });
      await expect(runtime.dispatchSystemAction('capability.invoke', { input: invocation, worktreePath: directory }, { signal: controller.signal })).rejects.toBe(reason);
      expect(observed?.signal).toBe(controller.signal);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['runtime', 'executor'] as const)('retains a late workspace handle through the actual default action and %s', async boundary => {
    const directory = await mkdtemp(join(tmpdir(), 'capability-default-ownership-'));
    const runtime = await createDefaultPluginRuntime({ homeDir: directory, workspaceRoot: directory });
    const controller = new AbortController();
    const workspace = { id: 'owned', repository: { url: 'fixture' }, runId: 'run', snapshot: { commit: 'a', branch: 'main', dirty: false } };
    const provider: RepositoryProvider = { id: 'repo', capabilities: { read: true, clone: true, push: false, prepare: true },
      snapshot: async () => workspace.snapshot,
      prepare: async (_request, options) => { expect(options?.signal).toBe(controller.signal); controller.abort(new Error('late allocation')); return workspace; } };
    try {
      await runtime.activate({ manifest: { id: 'repository.default-owned', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['repository.provider'] },
        activate: setup => setup.registerRepositoryProvider('repo', provider) });
      const input = { capability: 'repository.provider', provider: 'repo', operation: 'prepare', input: { repository: { url: 'fixture' }, runId: 'run' } };
      const executor = new SystemActionExecutor({ plugins: runtime, publishChange: async () => {}, queueQA: async () => {} });
      const result = boundary === 'runtime' ? runtime.dispatchSystemAction('capability.invoke', input, { signal: controller.signal })
        : executor.execute('capability.invoke', input, { signal: controller.signal });
      expect(await result).toEqual(workspace);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
