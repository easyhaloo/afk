import { describe, expect, it, vi } from 'vitest';
import type { ObservationContext, RunEventData } from '@afk/core';
import { LifecycleDispatcher, type LifecycleContext } from './lifecycle.js';

const context: LifecycleContext = {
  iid: 1, repoRoot: '/repo', projectName: 'org/repo', worktreePath: '/repo/.worktrees/1',
  baseBranch: 'main', sessionName: 'afk-1', params: {},
};

const observationContext: ObservationContext = {
  traceId: 'lifecycle-trace', runId: context.sessionName, workItemId: 'github:org/repo#1',
  profileId: 'development', purpose: 'learning', attempt: 1,
  actor: { kind: 'system', id: context.sessionName },
};

describe('LifecycleDispatcher', () => {
  it('runs typed phases in deterministic order and cleanup in reverse order', async () => {
    const calls: string[] = [];
    const dispatcher = new LifecycleDispatcher([
      { name: 'b', order: 20, onBeforeAgent: async () => calls.push('b:before'), onCleanup: async () => calls.push('b:cleanup') },
      { name: 'a', order: 10, onBeforeAgent: async () => calls.push('a:before'), onCleanup: async () => calls.push('a:cleanup') },
    ]);
    await dispatcher.run('before-agent', context);
    await dispatcher.run('cleanup', context);
    expect(calls).toEqual(['a:before', 'b:before', 'b:cleanup', 'a:cleanup']);
  });

  it('blocks required policy failures while still draining cleanup hooks', async () => {
    const calls: string[] = [];
    const record = vi.fn(async (_data: RunEventData) => {});
    const observedContext = { ...context, observation: { context: observationContext, record } };
    const dispatcher = new LifecycleDispatcher([
      { name: 'later', onBeforeAgent: async () => { calls.push('agent'); }, onCleanup: async () => { calls.push('cleanup'); } },
      { name: 'policy', order: -1, failureMode: 'required', onBeforeAgent: async () => { throw new Error('policy denied'); }, onCleanup: async () => { throw new Error('cleanup failed'); } },
    ]);
    await expect(dispatcher.run('before-agent', observedContext)).rejects.toThrow('policy denied');
    expect(calls).toEqual([]);
    await dispatcher.run('cleanup', observedContext);
    expect(calls).toEqual(['cleanup']);
    expect(record).not.toHaveBeenCalled();
  });

  it('drains strict cleanup modules and extensions in reverse order before aggregating every failure', async () => {
    const calls: string[] = [];
    const record = vi.fn(async (_data: RunEventData) => {});
    const highFailure = new Error('high module cleanup failed');
    const middleFailure = new Error('middle module cleanup failed');
    const extensionFailure = new Error('extension cleanup failed');
    const hooks = {
      low: vi.fn(async () => { calls.push('module:low'); }),
      middle: vi.fn(async () => { calls.push('module:middle'); throw middleFailure; }),
      high: vi.fn(async () => { calls.push('module:high'); throw highFailure; }),
      extensionLow: vi.fn(async () => { calls.push('extension:low'); }),
      extensionHigh: vi.fn(async () => { calls.push('extension:high'); throw extensionFailure; }),
    };
    const dispatcher = new LifecycleDispatcher([
      { name: 'middle', order: 20, onCleanup: hooks.middle },
      { name: 'low', order: 10, onCleanup: hooks.low },
      { name: 'high', order: 30, failureMode: 'required', onCleanup: hooks.high },
    ], { strictCleanup: true, isFatalError: error => error instanceof Error });
    dispatcher.register('cleanup', hooks.extensionHigh, 20);
    dispatcher.register('cleanup', hooks.extensionLow, 10);

    const cleanup = dispatcher.run('cleanup', { ...context, observation: { context: observationContext, record } });
    await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
    await expect(cleanup).rejects.toMatchObject({
      message: 'Lifecycle cleanup failed', errors: [highFailure, middleFailure, extensionFailure],
    });
    expect(calls).toEqual(['module:high', 'module:middle', 'module:low', 'extension:high', 'extension:low']);
    for (const hook of Object.values(hooks)) expect(hook).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps default cleanup best effort for required modules and extensions', async () => {
    const calls: string[] = [];
    const hooks = {
      moduleFailure: vi.fn(async () => { calls.push('module:failed'); throw new Error('module cleanup failed'); }),
      moduleSuccess: vi.fn(async () => { calls.push('module:success'); }),
      extensionFailure: vi.fn(async () => { calls.push('extension:failed'); throw new Error('extension cleanup failed'); }),
      extensionSuccess: vi.fn(async () => { calls.push('extension:success'); }),
    };
    const dispatcher = new LifecycleDispatcher([
      { name: 'success', order: 10, onCleanup: hooks.moduleSuccess },
      { name: 'failure', order: 20, failureMode: 'required', onCleanup: hooks.moduleFailure },
    ]);
    dispatcher.register('cleanup', hooks.extensionSuccess, 10);
    dispatcher.register('cleanup', hooks.extensionFailure, 20);

    await expect(dispatcher.run('cleanup', context)).resolves.toBeUndefined();
    expect(calls).toEqual(['module:failed', 'module:success', 'extension:failed', 'extension:success']);
    for (const hook of Object.values(hooks)) expect(hook).toHaveBeenCalledOnce();
  });

  it.each(['module', 'extension'] as const)('propagates a fatal optional %s error without running subsequent hooks', async source => {
    const fatal = new Error('required audit unavailable');
    const isFatalError = vi.fn((error: unknown) => error === fatal);
    const hooks = {
      fail: vi.fn(async () => { throw fatal; }),
      later: vi.fn(async () => {}),
      extension: vi.fn(async () => {}),
    };
    const dispatcher = new LifecycleDispatcher(source === 'module' ? [
      { name: 'optional', failureMode: 'best-effort', onBeforeAgent: hooks.fail },
      { name: 'later', onBeforeAgent: hooks.later },
    ] : [], { isFatalError });
    if (source === 'extension') {
      dispatcher.register('before-agent', hooks.fail, 10);
      dispatcher.register('before-agent', hooks.later, 20);
    }
    dispatcher.register('before-agent', hooks.extension, 30);

    await expect(dispatcher.run('before-agent', context)).rejects.toBe(fatal);
    expect(hooks.fail).toHaveBeenCalledOnce();
    expect(isFatalError).toHaveBeenCalledOnce();
    expect(isFatalError).toHaveBeenCalledWith(fatal);
    expect(hooks.later).not.toHaveBeenCalled();
    expect(hooks.extension).not.toHaveBeenCalled();
  });

  it('continues after nonfatal optional module and extension errors', async () => {
    const calls: string[] = [];
    const moduleFailure = new Error('optional module failed');
    const extensionFailure = new Error('optional extension failed');
    const isFatalError = vi.fn((error: unknown) => error === 'fatal');
    const hooks = {
      moduleFailure: vi.fn(async () => { calls.push('module:failed'); throw moduleFailure; }),
      moduleSuccess: vi.fn(async () => { calls.push('module:success'); }),
      extensionFailure: vi.fn(async () => { calls.push('extension:failed'); throw extensionFailure; }),
      extensionSuccess: vi.fn(async () => { calls.push('extension:success'); }),
    };
    const dispatcher = new LifecycleDispatcher([
      { name: 'optional', failureMode: 'best-effort', onAfterAgent: hooks.moduleFailure },
      { name: 'later', onAfterAgent: hooks.moduleSuccess },
    ], { isFatalError });
    dispatcher.register('after-agent', hooks.extensionFailure, 10);
    dispatcher.register('after-agent', hooks.extensionSuccess, 20);

    await expect(dispatcher.run('after-agent', context)).resolves.toBeUndefined();
    expect(calls).toEqual(['module:failed', 'module:success', 'extension:failed', 'extension:success']);
    expect(isFatalError.mock.calls).toEqual([[moduleFailure], [extensionFailure]]);
    for (const hook of Object.values(hooks)) expect(hook).toHaveBeenCalledOnce();
  });

  describe.each(['before-agent', 'after-agent', 'before-publish'] as const)('optional lifecycle audit (%s)', phase => {
    const hookName = phase === 'before-agent' ? 'onBeforeAgent' : phase === 'after-agent' ? 'onAfterAgent' : 'onBeforePublish';

    it.each(['module', 'extension'] as const)('records one safe %s failure receipt before continuing', async source => {
      const calls: string[] = [];
      const hookFailure = new Error('token=private-hook-secret');
      hookFailure.stack = 'private-hook-stack';
      const fail = vi.fn(async () => { calls.push('failed'); throw hookFailure; });
      const later = vi.fn(async () => { calls.push('later'); });
      const record = vi.fn(async (_data: RunEventData) => { calls.push('audit'); });
      const dispatcher = new LifecycleDispatcher(source === 'module' ? [
        { name: 'optional', failureMode: phase === 'before-agent' ? 'best-effort' : undefined, [hookName]: fail },
        { name: 'later', [hookName]: later },
      ] : []);
      if (source === 'extension') {
        dispatcher.register(phase, later, 20);
        dispatcher.register(phase, fail, 10);
      }

      await expect(dispatcher.run(phase, { ...context, observation: { context: observationContext, record } }))
        .resolves.toBeUndefined();

      expect(calls).toEqual(['failed', 'audit', 'later']);
      expect(fail).toHaveBeenCalledOnce();
      expect(later).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledWith({
        kind: 'effect.completed', effectKind: `workflow.lifecycle.${phase}`,
        idempotencyKey: JSON.stringify([observationContext.runId, 'lifecycle', phase, source, source === 'module' ? 'optional' : 1]),
        outcome: 'failed', summary: 'optional_lifecycle_hook_failed',
      });
      expect(JSON.stringify(record.mock.calls)).not.toContain('private-hook-secret');
      expect(JSON.stringify(record.mock.calls)).not.toContain('private-hook-stack');
    });

    it.each(['module', 'extension'] as const)('propagates %s receipt persistence failure without running later hooks', async source => {
      const hookFailure = new Error('optional hook failed');
      const auditFailure = new Error('audit persistence unavailable');
      const fail = vi.fn(async () => { throw hookFailure; });
      const later = vi.fn(async () => {});
      const extension = vi.fn(async () => {});
      const record = vi.fn(async (_data: RunEventData) => { throw auditFailure; });
      const dispatcher = new LifecycleDispatcher(source === 'module' ? [
        { name: 'optional', failureMode: 'best-effort', [hookName]: fail },
        { name: 'later', [hookName]: later },
      ] : [], { isFatalError: error => error === auditFailure });
      if (source === 'extension') {
        dispatcher.register(phase, later, 20);
        dispatcher.register(phase, fail, 10);
      }
      dispatcher.register(phase, extension, 30);

      await expect(dispatcher.run(phase, { ...context, observation: { context: observationContext, record } }))
        .rejects.toBe(auditFailure);

      expect(fail).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledOnce();
      expect(later).not.toHaveBeenCalled();
      expect(extension).not.toHaveBeenCalled();
    });

    it.each(['module', 'extension'] as const)('preserves cancellation after an optional %s fails without recording a hook failure', async source => {
      const controller = new AbortController();
      const cancellation = new Error('cancelled lifecycle');
      const fail = vi.fn(async () => { controller.abort(cancellation); throw new Error('optional hook failed'); });
      const later = vi.fn(async () => {});
      const record = vi.fn(async (_data: RunEventData) => {});
      const dispatcher = new LifecycleDispatcher(source === 'module' ? [
        { name: 'optional', [hookName]: fail }, { name: 'later', [hookName]: later },
      ] : []);
      if (source === 'extension') {
        dispatcher.register(phase, fail, 10);
        dispatcher.register(phase, later, 20);
      }

      await expect(dispatcher.run(phase, { ...context, signal: controller.signal,
        observation: { context: observationContext, record } })).rejects.toBe(cancellation);

      expect(fail).toHaveBeenCalledOnce();
      expect(record).not.toHaveBeenCalled();
      expect(later).not.toHaveBeenCalled();
    });
  });
});
