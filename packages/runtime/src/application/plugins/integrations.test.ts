import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  ContextSource, NotificationProvider, PolicyCheckProvider, PolicyDecision, VerificationProvider,
} from '../../plugin-sdk/capabilities.js';
import { TestReportProvider } from '../../infrastructure/providers/artifacts.js';
import { TestRunnerVerificationProvider } from '../../infrastructure/verification/index.js';
import { assemblePrompt, type PromptSegment } from '../workflows/execution-protocol.js';
import { LifecycleDispatcher, type LifecycleContext } from '../workflows/lifecycle.js';
import { SystemActionExecutor } from '../workflows/system-actions.js';
import {
  createCapabilityLifecycle, registerVerificationSystemActions, type CapabilityLifecycleSelection,
} from './integrations.js';
import { PluginRuntime } from './runtime.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const context: LifecycleContext = {
  iid: 42, worktreePath: '/repo/worktree', baseBranch: 'main', sessionName: 'afk-42', params: {},
};

async function fixture() {
  const calls: string[] = [];
  const runtime = new PluginRuntime();
  const policy = {
    id: 'policy', capabilities: { 'pre-execution': true, 'post-execution': false, 'static-review': false },
    evaluate: vi.fn(async (): Promise<PolicyDecision> => { calls.push('policy'); return { allowed: true }; }),
  } satisfies PolicyCheckProvider;
  const source = {
    id: 'wiki', capabilities: { 'read-only': true, summarize: true, search: true },
    gather: vi.fn(async () => { calls.push('gather'); return [{ content: 'Use the existing service', origin: 'wiki/design' }]; }),
  } satisfies ContextSource;
  const notification = {
    id: 'notification', capabilities: { 'direct-message': true, 'channel-post': true, mention: true },
    notify: vi.fn(async () => { calls.push('notify'); return { delivered: true, channel: 'team' }; }),
  } satisfies NotificationProvider;
  const verification = {
    id: 'verification', capabilities: { 'static-analysis': true, 'test-execution': true, 'custom-script': false },
    verify: vi.fn(async () => ({ passed: true, durationMs: 3, output: 'tests passed' })),
  } satisfies VerificationProvider;
  await runtime.activate({
    manifest: {
      id: 'test.integrations', version: '1.0.0', apiVersion: 1, trusted: true,
      provides: ['policy.provider', 'context.provider', 'notification.provider', 'verification.provider'],
    },
    activate(setup) {
      setup.registerPolicyProvider('policy', policy);
      setup.registerContextProvider('wiki', source);
      setup.registerNotificationProvider('notification', notification);
      setup.registerVerificationProvider('verification', verification);
    },
  });
  return { runtime, calls, policy, source, notification, verification };
}

describe('createCapabilityLifecycle', () => {
  it('checks agent output policy before publishing artifacts or notifying', async () => {
    const { runtime, policy, notification, verification } = await fixture();
    const publish = vi.fn();
    const request = vi.fn((ctx: LifecycleContext) => ({ target: ctx.worktreePath }));
    const module = createCapabilityLifecycle(runtime, {
      policies: [{ provider: 'policy', input: () => ({ action: 'execute' }) }],
      verifications: [{ provider: 'verification', request }],
      artifacts: [{ provider: 'reports', artifact: () => ({ name: 'result', mediaType: 'text/plain', bytes: Buffer.from('result') }), publish }],
      notifications: [{ provider: 'notification', message: () => ({ title: 'done', body: '' }) }],
    });
    await module.onBeforeAgent!(context);
    policy.evaluate.mockResolvedValueOnce({ allowed: false });
    await expect(new LifecycleDispatcher([module]).run('before-publish', context)).rejects.toThrow('denied');
    policy.evaluate.mockResolvedValueOnce({ allowed: false });
    await expect(module.onAfterAgent!(context)).rejects.toThrow('denied');
    expect(publish).not.toHaveBeenCalled();
    expect(notification.notify).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(verification.verify).not.toHaveBeenCalled();
  });
  it('passes selected context fragments to the actual prompt assembler after policy evaluation', async () => {
    const { runtime, calls, policy, source } = await fixture();
    const segments: PromptSegment[] = [{ label: 'goal', text: 'Implement issue 42' }];
    const original = structuredClone(context);
    const module = createCapabilityLifecycle(runtime, {
      policies: [{ provider: 'policy', input: ctx => ({ action: 'execute', context: { iid: ctx.iid, worktreePath: ctx.worktreePath } }) }],
      contexts: [{
        provider: 'wiki', query: ctx => ({ scope: ctx.worktreePath, prompt: `Issue ${ctx.iid}` }),
        consume(fragments, ctx) {
          expect(ctx).toBe(context);
          calls.push('prompt');
          segments.push(...fragments.map(fragment => ({ label: fragment.origin, text: fragment.content })));
        },
      }],
    });
    await new LifecycleDispatcher([module]).run('before-agent', context);
    expect(calls).toEqual(['policy', 'gather', 'prompt']);
    expect(policy.evaluate).toHaveBeenCalledWith({ action: 'execute', context: { iid: 42, worktreePath: '/repo/worktree' } });
    expect(source.gather).toHaveBeenCalledWith({ scope: '/repo/worktree', prompt: 'Issue 42' });
    expect(assemblePrompt(segments)).toBe('Implement issue 42\n\nUse the existing service');
    expect(context).toEqual(original);
  });

  it.each(['deny', 'error', 'malformed', 'missing'] as const)('fails closed on policy %s before context consumption', async failure => {
    const { runtime, policy, source, notification } = await fixture();
    if (failure === 'deny') policy.evaluate.mockResolvedValueOnce({ allowed: false, reason: 'denied' });
    if (failure === 'error') policy.evaluate.mockRejectedValueOnce(new Error('policy unavailable'));
    if (failure === 'malformed') policy.evaluate.mockResolvedValueOnce({ allowed: 'yes' } as unknown as PolicyDecision);
    const consume = vi.fn();
    const module = createCapabilityLifecycle(runtime, {
      policies: [{ provider: failure === 'missing' ? 'missing' : 'policy', input: () => ({ action: 'execute' }) }],
      contexts: [{ provider: 'wiki', query: () => ({ scope: '.', prompt: 'Task' }), consume }],
      notifications: [{ provider: 'notification', message: () => ({ title: 'Complete', body: 'Done' }) }],
    });
    await runtime.activate({
      manifest: { id: 'test.required-lifecycle', version: '1.0.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true },
      activate: setup => setup.registerLifecycle(module),
    });
    expect(module.failureMode).toBe('required');
    const next = vi.fn();
    await expect(new LifecycleDispatcher([...runtime.getLifecycleModules(), { name: 'next', onBeforeAgent: next }]).run('before-agent', context)).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(source.gather).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(notification.notify).not.toHaveBeenCalled();
  });

  it('propagates missing, failed context and prompt consumption errors', async () => {
    const { runtime, source } = await fixture();
    const consume = vi.fn().mockRejectedValueOnce(new Error('prompt unavailable'));
    const selection = { contexts: [{ provider: 'wiki', query: () => ({ scope: '.', prompt: 'Task' }), consume }] };
    const module = createCapabilityLifecycle(runtime, selection);
    await expect(module.onBeforeAgent!(context)).rejects.toThrow('prompt unavailable');
    source.gather.mockRejectedValueOnce(new Error('context unavailable'));
    await expect(module.onBeforeAgent!(context)).rejects.toThrow('context unavailable');
    expect(consume).toHaveBeenCalledTimes(1);
    await expect(createCapabilityLifecycle(runtime, {
      contexts: [{ ...selection.contexts[0], provider: 'missing' }],
    }).onBeforeAgent!(context)).rejects.toThrow('not registered');
  });

  it('persists real artifact bytes, publishes the reference and then notifies with completion evidence', async () => {
    const { runtime, calls, notification, verification } = await fixture();
    verification.verify.mockImplementation(async () => {
      calls.push('verify');
      return { passed: true, durationMs: 3, output: 'tests passed' };
    });
    const request = vi.fn(async (ctx: LifecycleContext) => ({ target: ctx.worktreePath, command: ['npm', 'test'], timeoutMs: 5000 }));
    const root = await mkdtemp(join(tmpdir(), 'afk-capability-evidence-'));
    temporaryDirectories.push(root);
    const sink = new TestReportProvider({ root });
    const put = vi.spyOn(sink, 'put');
    await runtime.activate({
      manifest: { id: 'test.artifacts', version: '1.0.0', apiVersion: 1, provides: ['artifact.provider'], trusted: true },
      activate: setup => setup.registerArtifactProvider('reports', sink),
    });
    const publish = vi.fn(async artifact => {
      calls.push('publish');
      expect(await readFile(fileURLToPath(artifact.uri), 'utf8')).toBe('issue=42\nsession=afk-42');
    });
    const module = createCapabilityLifecycle(runtime, {
      policies: [{ provider: 'policy', input: () => ({ action: 'execute' }) }],
      verifications: [{ provider: 'verification', request }],
      artifacts: [{
        provider: 'reports',
        artifact: ctx => ({ name: `evidence-${ctx.iid}.txt`, mediaType: 'text/plain', bytes: Buffer.from(`issue=${ctx.iid}\nsession=${ctx.sessionName}`) }),
        publish,
      }],
      notifications: [{
        provider: 'notification', message: (ctx, evidence) => {
          expect(evidence[0].provider).toBe('reports');
          return { title: `Issue ${ctx.iid} complete`, body: evidence[0].artifact.uri };
        },
      }],
    });
    await module.onBeforeAgent!(context);
    expect(verification.verify).not.toHaveBeenCalled();
    calls.length = 0;
    await new LifecycleDispatcher([module]).run('after-agent', context);
    expect(request).toHaveBeenNthCalledWith(1, context);
    expect(verification.verify).toHaveBeenNthCalledWith(1, { target: context.worktreePath, command: ['npm', 'test'], timeoutMs: 5000 });
    expect(put).toHaveBeenCalledWith({ name: 'evidence-42.txt', mediaType: 'text/plain', bytes: Buffer.from('issue=42\nsession=afk-42') });
    expect(publish).toHaveBeenCalledWith({ uri: new URL(`file://${root}/evidence-42.txt`).href, name: 'evidence-42.txt' }, context);
    expect(notification.notify).toHaveBeenCalledWith({ title: 'Issue 42 complete', body: publish.mock.calls[0][0].uri });
    expect(calls).toEqual(['policy', 'verify', 'publish', 'notify']);
    calls.length = 0;
    const current = { ...context, worktreePath: '/repo/current-publish', params: { verification: { target: '/untrusted/target' } } };
    const publication = vi.fn(async () => { calls.push('publication'); });
    await new LifecycleDispatcher([module, { name: 'publication', onBeforePublish: publication }]).run('before-publish', current);
    expect(request).toHaveBeenNthCalledWith(2, current);
    expect(verification.verify).toHaveBeenNthCalledWith(2, { target: current.worktreePath, command: ['npm', 'test'], timeoutMs: 5000 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(notification.notify).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['policy', 'verify', 'publication']);
  });

  it.each((['after-agent', 'before-publish'] as const).flatMap(phase =>
    (['missing', 'invalid-request', 'invalid-output', 'failed', 'sync-error', 'async-error'] as const).map(failure => ({ phase, failure }))))(
    'blocks downstream lifecycle effects on $phase verification $failure', async ({ phase, failure }) => {
      const { runtime, verification, notification } = await fixture();
      const error = new Error(`verification ${failure}`);
      if (failure === 'invalid-output') verification.verify.mockResolvedValueOnce({ passed: true, durationMs: -1, output: 'invalid' });
      if (failure === 'failed') verification.verify.mockResolvedValueOnce({ passed: false, durationMs: 3, output: 'failed' });
      if (failure === 'sync-error') verification.verify.mockImplementationOnce(() => { throw error; });
      if (failure === 'async-error') verification.verify.mockRejectedValueOnce(error);
      const artifact = vi.fn(() => ({ name: 'report', mediaType: 'text/plain', bytes: Buffer.from('report') }));
      const publish = vi.fn();
      const nextRequest = vi.fn((ctx: LifecycleContext) => ({ target: ctx.worktreePath }));
      const module = createCapabilityLifecycle(runtime, {
        verifications: [{
          provider: failure === 'missing' ? 'missing' : 'verification',
          request: ctx => ({ target: ctx.worktreePath, timeoutMs: failure === 'invalid-request' ? -1 : 5000 }),
        }, { provider: 'verification', request: nextRequest }],
        artifacts: [{ provider: 'reports', artifact, publish }],
        notifications: [{ provider: 'notification', message: () => ({ title: 'Done', body: 'Done' }) }],
      });
      await runtime.activate({
        manifest: { id: 'test.required-verification', version: '1.0.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true },
        activate: setup => setup.registerLifecycle(module),
      });
      const publication = vi.fn();
      const pending = new LifecycleDispatcher([...runtime.getLifecycleModules(), {
        name: 'publication', onAfterAgent: publication, onBeforePublish: publication,
      }]).run(phase, context);
      if (failure === 'sync-error' || failure === 'async-error') await expect(pending).rejects.toBe(error);
      else await expect(pending).rejects.toThrow(failure === 'failed' ? 'Capability verification failed'
        : failure === 'invalid-output' ? 'Invalid capability result'
          : failure === 'invalid-request' ? 'Invalid or unsupported capability invocation' : 'not registered');
      expect(module.failureMode).toBe('required');
      expect(verification.verify).toHaveBeenCalledTimes(failure === 'missing' || failure === 'invalid-request' ? 0 : 1);
      expect(nextRequest).not.toHaveBeenCalled();
      expect(artifact).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(notification.notify).not.toHaveBeenCalled();
      expect(publication).not.toHaveBeenCalled();
    });

  it('consumes a concretely registered verification provider through the required lifecycle', async () => {
    const { runtime, verification } = await fixture();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'selected provider', stderr: '' }));
    await runtime.activate({
      manifest: { id: 'test.lifecycle-verification', version: '1.0.0', apiVersion: 1, provides: ['verification.provider'], trusted: true },
      activate: setup => setup.registerVerificationProvider('selected-runner', new TestRunnerVerificationProvider({ runner })),
    });
    const module = createCapabilityLifecycle(runtime, {
      verifications: [{ provider: 'selected-runner', request: ctx => ({ target: ctx.worktreePath, command: ['npm', 'test'], timeoutMs: 5000 }) }],
    });
    await new LifecycleDispatcher([module]).run('before-publish', context);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(['npm', 'test'], expect.objectContaining({ cwd: context.worktreePath, timeoutMs: 5000 }));
    expect(verification.verify).not.toHaveBeenCalled();
  });

  it('does not notify when artifact storage or evidence publication fails', async () => {
    const { runtime, notification } = await fixture();
    const publish = vi.fn().mockRejectedValueOnce(new Error('publish failed'));
    const artifacts = [{
      provider: 'reports', artifact: () => ({ name: 'report', mediaType: 'text/plain', bytes: Buffer.from('data') }), publish,
    }];
    const selection: CapabilityLifecycleSelection = {
      artifacts, notifications: [{ provider: 'notification', message: () => ({ title: 'Done', body: 'Done' }) }],
    };
    const module = createCapabilityLifecycle(runtime, selection);
    await expect(module.onAfterAgent!(context)).rejects.toThrow('not registered');
    expect(publish).not.toHaveBeenCalled();
    await runtime.activate({
      manifest: { id: 'test.reports', version: '1.0.0', apiVersion: 1, provides: ['artifact.provider'], trusted: true },
      activate: setup => setup.registerArtifactProvider('reports', {
        id: 'reports', capabilities: { write: true, read: false, list: false },
        put: async () => ({ uri: 'file:///report', name: 'report' }),
      }),
    });
    await expect(module.onAfterAgent!(context)).rejects.toThrow('publish failed');
    expect(notification.notify).not.toHaveBeenCalled();
  });

  it('treats undelivered notifications and invalid selected providers as failures', async () => {
    const { runtime, notification } = await fixture();
    notification.notify.mockResolvedValueOnce({ delivered: false, channel: 'team' });
    const module = createCapabilityLifecycle(runtime, {
      notifications: [{ provider: 'notification', message: () => ({ title: 'Done', body: 'Done' }) }],
    });
    await expect(new LifecycleDispatcher([module]).run('after-agent', context)).rejects.toThrow('not delivered');
    await expect(createCapabilityLifecycle(runtime, {
      notifications: [{ provider: 'missing', message: () => ({ title: 'Done', body: 'Done' }) }],
    }).onAfterAgent!(context)).rejects.toThrow('not registered');
  });

  it('executes only explicitly selected integrations', async () => {
    const { runtime, policy, source, notification, verification } = await fixture();
    const module = createCapabilityLifecycle(runtime, {});
    await module.onBeforeAgent!(context);
    await module.onAfterAgent!(context);
    await module.onBeforePublish!(context);
    expect(policy.evaluate).not.toHaveBeenCalled();
    expect(source.gather).not.toHaveBeenCalled();
    expect(notification.notify).not.toHaveBeenCalled();
    expect(verification.verify).not.toHaveBeenCalled();
  });
});

describe('registerVerificationSystemActions', () => {
  async function register(runtime: PluginRuntime) {
    const engineInput = z.object({
      worktreePath: z.string(),
      step: z.object({
        input: z.object({ target: z.string().optional(), command: z.array(z.string()).optional(), timeoutMs: z.number().optional() }).strict().optional(),
      }).passthrough(),
    }).passthrough();
    await runtime.activate({
      manifest: { id: 'test.actions', version: '1.0.0', apiVersion: 1, provides: ['workflow.action'], trusted: true },
      activate: setup => registerVerificationSystemActions(runtime, setup, [{
        name: 'verify-selected', provider: 'verification', request(input) {
          const execution = engineInput.parse(input);
          return { target: execution.worktreePath, command: ['npm', 'test'], timeoutMs: 5000, ...execution.step.input };
        },
      }]),
    });
    return new SystemActionExecutor({ plugins: runtime, publishChange: vi.fn(), queueQA: vi.fn() });
  }

  const execution = {
    iid: 42, worktreePath: '/repo/worktree', branch: 'feat/42', targetBranch: 'main',
    step: { input: { command: ['npm', 'test'], timeoutMs: 5000 } },
  };

  it('registers an executable typed action and maps the existing engine input to a verification request', async () => {
    const { runtime, verification } = await fixture();
    const executor = await register(runtime);
    expect(runtime.listSystemActions()).toEqual(['verify-selected']);
    await expect(executor.execute('verify-selected', execution)).resolves.toEqual({ passed: true, durationMs: 3, output: 'tests passed' });
    expect(verification.verify).toHaveBeenCalledWith({ target: '/repo/worktree', command: ['npm', 'test'], timeoutMs: 5000 });
  });

  it('fails the system step on failed verification and propagates provider errors', async () => {
    const { runtime, verification } = await fixture();
    const executor = await register(runtime);
    verification.verify.mockResolvedValueOnce({ passed: false, durationMs: 3, output: 'failed' });
    await expect(executor.execute('verify-selected', execution)).rejects.toThrow('verification failed');
    verification.verify.mockRejectedValueOnce(new Error('runner unavailable'));
    await expect(executor.execute('verify-selected', execution)).rejects.toThrow('runner unavailable');
  });

  it('rejects invalid engine input and invalid mapped requests before execution', async () => {
    const { runtime, verification } = await fixture();
    const executor = await register(runtime);
    await expect(executor.execute('verify-selected', { ...execution, worktreePath: null })).rejects.toThrow();
    await runtime.activate({
      manifest: { id: 'test.invalid-action', version: '1.0.0', apiVersion: 1, provides: ['workflow.action'], trusted: true },
      activate: setup => registerVerificationSystemActions(runtime, setup, [{
        name: 'verify-invalid', provider: 'verification', request: () => ({ target: '/repo', timeoutMs: -1 }),
      }]),
    });
    await expect(executor.execute('verify-invalid', execution)).rejects.toThrow('Invalid or unsupported capability invocation');
    expect(verification.verify).not.toHaveBeenCalled();
  });

  it('runs the concrete verification provider through a registered system action', async () => {
    const runtime = new PluginRuntime();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'real provider', stderr: '' }));
    await runtime.activate({
      manifest: { id: 'test.concrete-verification', version: '1.0.0', apiVersion: 1, provides: ['verification.provider'], trusted: true },
      activate: setup => setup.registerVerificationProvider('verification', new TestRunnerVerificationProvider({ runner })),
    });
    const executor = await register(runtime);
    await expect(executor.execute('verify-selected', execution)).resolves.toMatchObject({ passed: true, output: 'real provider' });
    expect(runner).toHaveBeenCalledWith(['npm', 'test'], expect.objectContaining({ cwd: '/repo/worktree', timeoutMs: 5000 }));
  });
});
