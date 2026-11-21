import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderOperationOptions, RepositoryWorkspace } from '../../plugin-sdk/capabilities.js';
import type { CommandRequest, CommandResult } from './dependencies.js';
import { MultiRepositoryProvider, SpecialGitBackendProvider } from './repositories.js';

const targets = ['multi-snapshot', 'special-snapshot', 'prepare', 'checkout', 'publish', 'cleanup'] as const;
type Target = typeof targets[number];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture(target: Target) {
  const input = { repository: { url: 'repo', ref: 'main' }, runId: 'run-deadline' };
  let workspace: RepositoryWorkspace = { ...input, id: 'owned', snapshot: { commit: 'a'.repeat(40), branch: 'HEAD', dirty: false } };
  let active = false;
  let received: CommandRequest | undefined;
  let finish!: (failure?: boolean) => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const executor = vi.fn(async (request: CommandRequest): Promise<CommandResult> => {
    const operation = request.args[0];
    if (operation === 'checkout') workspace = { ...workspace, snapshot: { ...workspace.snapshot, branch: 'feat/deadline' } };
    const payload = operation === 'prepare' || operation === 'checkout' ? workspace
      : operation === 'cleanup' ? { removed: true } : workspace.snapshot;
    const stdout = request.command === 'git' ? operation === 'status' ? ''
      : request.args.includes('--abbrev-ref') ? workspace.snapshot.branch : workspace.snapshot.commit : JSON.stringify(payload);
    const result = { stdout, stderr: '' };
    if (!active || (!target.endsWith('snapshot') && operation !== target)) return result;
    active = false;
    received = request;
    start();
    return new Promise((resolve, reject) => {
      finish = failure => failure ? reject(new Error('backend diagnostic')) : resolve(result);
    });
  });
  const special = new SpecialGitBackendProvider({ backend: 'inert-backend', executor,
    lifecycle: { repositories: [input.repository], operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
  const multi = new MultiRepositoryProvider({ repositories: [{ name: 'repo', path: '/inert/repo' }], git: executor });
  const request = { workspaceId: workspace.id };
  if (['checkout', 'publish', 'cleanup'].includes(target)) await special.prepare(input);
  if (target === 'publish') await special.checkout({ ...request, branch: 'feat/deadline' });
  active = true;
  const run = (options?: ProviderOperationOptions) => {
    if (target === 'multi-snapshot') return multi.snapshot({ url: 'repo' }, options);
    if (target === 'special-snapshot') return special.snapshot({ url: 'repo' }, options);
    if (target === 'prepare') return special.prepare(input, options);
    if (target === 'checkout') return special.checkout({ ...request, branch: 'feat/deadline' }, options);
    if (target === 'publish') return special.publish(request, options);
    return special.cleanup(request, options);
  };
  return { run, started, executor, received: () => received!, finish: (failure = true) => finish(failure) };
}

describe.each(targets)('repository command deadline: %s', target => {
  it.each([false, true])('retains an elapsed deadline across executor settlement (reject=%s)', async failure => {
    vi.useFakeTimers();
    const f = await fixture(target);
    const caller = new AbortController();
    const deadlineAt = Date.now() + 60;
    let settled = false;
    const result = f.run({ deadlineAt, signal: caller.signal }).catch(error => error).finally(() => { settled = true; });
    await f.started;
    await vi.advanceTimersByTimeAsync(60);
    expect(f.received().signal?.aborted).toBe(true);
    expect(f.received().deadlineAt).toBe(deadlineAt);
    expect(caller.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    vi.setSystemTime(deadlineAt - 1);
    f.finish(failure);
    expect(await result).toBe(f.received().signal?.reason);
    expect(await result).toEqual(new Error('Repository command deadline exceeded'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks the absolute deadline when the timer wakes before wall-clock expiry', async () => {
    vi.useFakeTimers();
    const f = await fixture(target);
    const start = Date.now();
    const result = f.run({ deadlineAt: start + 60 }).catch(error => error);
    await f.started;
    vi.setSystemTime(start - 1);
    await vi.advanceTimersByTimeAsync(60);
    expect(Date.now()).toBe(start + 59);
    expect(f.received().signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.received().signal?.aborted).toBe(true);
    f.finish();
    expect(await result).toEqual(new Error('Repository command deadline exceeded'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([60_001, 2_147_483_700])('does not replace a %sms absolute deadline with a 30s timeout', async duration => {
    vi.useFakeTimers();
    const f = await fixture(target);
    const deadlineAt = Date.now() + duration;
    const result = f.run({ deadlineAt }).catch(error => error);
    await f.started;
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(f.received().signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.received().signal?.aborted).toBe(true);
    f.finish();
    expect(await result).toEqual(new Error('Repository command deadline exceeded'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, undefined, new Error('caller cancelled')])('preserves caller cancellation %s after executor cleanup', async reason => {
    vi.useFakeTimers();
    const f = await fixture(target);
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    let settled = false;
    const result = f.run({ deadlineAt: Date.now() + 60_001, signal: caller.signal }).catch(error => error)
      .finally(() => { settled = true; });
    await f.started;
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(f.received().signal?.reason).toBe(caller.signal.reason);
    f.finish();
    expect(await result).toBe(caller.signal.reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves ordinary failure handling before the deadline', async () => {
    vi.useFakeTimers();
    const f = await fixture(target);
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const result = f.run({ deadlineAt: Date.now() + 60_001, signal: caller.signal }).catch(error => error);
    await f.started;
    f.finish();
    const message = target === 'multi-snapshot' ? 'backend diagnostic' : target === 'special-snapshot'
      ? 'special git backend snapshot command failed' : 'special git backend lifecycle command failed';
    expect(await result).toEqual(new Error(message));
    expect(f.received().signal?.aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects completion past the absolute deadline without timer dispatch', async () => {
    vi.useFakeTimers();
    const f = await fixture(target);
    const deadlineAt = Date.now() + 60;
    const result = f.run({ deadlineAt }).catch(error => error);
    await f.started;
    vi.setSystemTime(deadlineAt);
    expect(f.received().signal?.aborted).toBe(false);
    f.finish(false);
    expect(await result).toEqual(new Error('Provider operation deadline exceeded'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline and caller listener after successful completion', async () => {
    vi.useFakeTimers();
    const f = await fixture(target);
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const result = f.run({ deadlineAt: Date.now() + 60, signal: caller.signal });
    await f.started;
    f.finish(false);
    await result;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60);
    caller.abort();
    expect(f.received().signal?.aborted).toBe(false);
  });

  it('preserves the caller signal and reason when no deadline is supplied', async () => {
    const f = await fixture(target);
    const caller = new AbortController();
    const result = f.run({ signal: caller.signal }).catch(error => error);
    await f.started;
    expect(f.received().signal).toBe(caller.signal);
    caller.abort(null);
    f.finish();
    expect(await result).toBe(null);
  });

  it.each([0, NaN, Infinity])('rejects an expired or invalid deadline %s before executor IO', async deadlineAt => {
    const f = await fixture(target);
    f.executor.mockClear();
    await expect(f.run({ deadlineAt })).rejects.toThrow('Provider operation deadline exceeded');
    expect(f.executor).not.toHaveBeenCalled();
  });
});
