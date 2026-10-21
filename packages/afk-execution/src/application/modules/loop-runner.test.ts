import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopRunner, type LoopProviderBundle } from './loop-runner.js';
import type { ProviderBundle } from '@afk/infrastructure';
import type { BacklogItem } from '@afk/application';

const item: BacklogItem = {
  id: '42', title: 'verify me', dependsOn: [], state: 'ready', executionMode: 'afk',
  tags: [], branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42',
};
const selection = {
  backlogIds: ['42'],
  managedExecution: { workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json' },
};
const readManifest = vi.fn(async () => ({
  workItemId: 'github:org/repo#42', providerBacklogId: '42',
  tracker: { platform: 'github', projectKey: 'org/repo' },
} as any));

function providersFor(items: BacklogItem[] = [item]) {
  const backlog = {
    get: vi.fn(async (id: string) => items.find(candidate => candidate.id === id) ?? item),
    list: vi.fn(async ({ state }: { state: string }) => items.filter(candidate => candidate.state === state)),
    isRunnable: vi.fn(async () => true), claim: vi.fn(),
  };
  return { providers: { backlog, branches: {}, changes: {} } as unknown as ProviderBundle, backlog };
}

describe('LoopRunner manifest-bound execution', () => {
  it('rejects a manifest-less or ambiguous scope before any provider operation', () => {
    const { providers, backlog } = providersFor();
    expect(() => new LoopRunner(providers)).toThrow(/execution manifest/);
    expect(() => new LoopRunner(providers, { backlogIds: ['42'] })).toThrow(/execution manifest/);
    expect(() => new LoopRunner(providers, { ...selection, backlogIds: ['42', '43'] })).toThrow(/exactly one/);
    expect(backlog.list).not.toHaveBeenCalled();
  });

  it('rejects mismatched manifest before polling or claiming', async () => {
    const { providers, backlog } = providersFor();
    const executeManagedWorkItem = vi.fn();
    const subject = new LoopRunner(providers, {
      ...selection,
      readManifest: vi.fn(async () => ({ ...await readManifest(), providerBacklogId: '43' })),
      executeManagedWorkItem,
    });
    await expect(subject.start()).rejects.toThrow(/manifest.*42|backlog.*43/i);
    expect(backlog.list).not.toHaveBeenCalled();
    expect(backlog.claim).not.toHaveBeenCalled();
    expect(executeManagedWorkItem).not.toHaveBeenCalled();
  });

  it('polls ready and rework, but executes only the scoped work item', async () => {
    const rework = { ...item, state: 'rework' as const };
    const other = { ...item, id: '43', branchName: 'afk/backlog-43' };
    const { providers, backlog } = providersFor([rework, other]);
    const executeManagedWorkItem = vi.fn(async () => ({ status: 'merge_ready' } as any));
    const subject = new LoopRunner(providers, { ...selection, template: 'custom', readManifest, executeManagedWorkItem });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    await internals.poll();
    await vi.waitFor(() => expect(subject.getStatus().totals.completed).toBe(1));
    expect(backlog.list).toHaveBeenCalledWith({ state: 'ready', executionMode: 'afk' });
    expect(backlog.list).toHaveBeenCalledWith({ state: 'rework', executionMode: 'afk' });
    expect(executeManagedWorkItem).toHaveBeenCalledOnce();
    expect(executeManagedWorkItem).toHaveBeenCalledWith({
      workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json', template: 'custom',
    });
    expect(subject.getStatus().execution).toEqual({ active: 0, ids: [] });
    expect(internals.inFlight.has('42')).toBe(false);
  });

  it('asks only for the states a person does not own', async () => {
    // A merge_ready item is waiting for someone to read the change before
    // it is merged. A loop that picked it up would be merging on a
    // person's behalf without their having read it.
    const { providers, backlog } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection, readManifest,
      executeManagedWorkItem: vi.fn(async () => ({ status: 'merge_ready' } as any)),
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    await internals.poll();

    const asked = (backlog.list as any).mock.calls.map(([options]: [any]) => options);
    expect(asked).toEqual([
      { state: 'ready', executionMode: 'afk' },
      { state: 'rework', executionMode: 'afk' },
    ]);
    expect(asked.map((options: any) => options.state)).not.toContain('merge_ready');
  });

  it('does not merge what it ran, even handed a merge-capable provider', async () => {
    // The loop runs work; merging is a person's decision about a change
    // they have not read. Its seam does not carry a merge provider, and a
    // loop that had one would still not use it.
    const { providers, backlog } = providersFor();
    const merge = vi.fn();
    const bundle = { backlog, changes: { merge } } as unknown as LoopProviderBundle;
    const subject = new LoopRunner(bundle, {
      ...selection, readManifest,
      executeManagedWorkItem: vi.fn(async () => ({ status: 'merge_ready' } as any)),
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    await internals.poll();
    await vi.waitFor(() => expect(subject.getStatus().totals.completed).toBe(1));

    expect(merge).not.toHaveBeenCalled();
  });

  it('refuses another provider project even with the same issue number', async () => {
    const { providers } = providersFor([{ ...item, providerRef: 'github:other/repo#42' }]);
    const executeManagedWorkItem = vi.fn();
    const subject = new LoopRunner(providers, { ...selection, readManifest, executeManagedWorkItem });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    await internals.runManagedChain('42');
    expect(executeManagedWorkItem).not.toHaveBeenCalled();
    expect(subject.getStatus().lastError['42']).toMatch(/identity/);
  });

  it.each([['rework', 0, 0], ['blocked', 0, 1], ['not_claimed', 0, 0]] as const)(
    'records %s without a second execution chain', async (status, completed, failed) => {
      const { providers } = providersFor();
      const subject = new LoopRunner(providers, {
        ...selection, readManifest,
        executeManagedWorkItem: vi.fn(async () => ({ status } as any)),
      });
      const internals = subject as any;
      await internals.validateManagedExecution();
      internals.running = true;
      internals.emitEvent = vi.fn();
      await internals.runManagedChain('42');
      expect(subject.getStatus().totals).toMatchObject({ completed, failed });
      expect(subject.getStatus().execution.active).toBe(0);
    },
  );

  it('counts execution errors without retrying through another runner', async () => {
    const { providers } = providersFor();
    const executeManagedWorkItem = vi.fn(async () => { throw new Error('audit unavailable'); });
    const subject = new LoopRunner(providers, { ...selection, readManifest, executeManagedWorkItem });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    internals.inFlight.add('42');
    await internals.runManagedChain('42');
    expect(executeManagedWorkItem).toHaveBeenCalledOnce();
    expect(subject.getStatus().totals.failed).toBe(1);
    expect(subject.getStatus().lastError['42']).toContain('audit unavailable');
    expect(internals.inFlight.has('42')).toBe(false);
  });

  it('makes duplicate stop calls idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'afk-managed-loop-'));
    const { providers } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection,
      pidFilePath: join(directory, 'loop.pid'),
      statusFilePath: join(directory, 'status.json'),
      readManifest,
    });
    const internals = subject as any;
    internals.running = true;
    internals.emitEvent = vi.fn();
    internals.inExecution.set('42', { iid: '42', session: 'run-42', startedAt: Date.now() });
    vi.useFakeTimers();

    try {
      const firstStop = subject.stop();
      const secondStop = subject.stop();
      expect(firstStop).toBe(secondStop);
      let resolved = false;
      void secondStop.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(50);
      expect(resolved).toBe(false);
      internals.inExecution.clear();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([firstStop, secondStop]);
      expect(vi.getTimerCount()).toBe(0);
      expect(internals.emitEvent).toHaveBeenCalledTimes(2);
      expect(internals.emitEvent).toHaveBeenNthCalledWith(1, 'stopping: clearing timers and draining...');
      expect(internals.emitEvent).toHaveBeenNthCalledWith(2, 'stopped: all in-flight drained');
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forces shutdown after the configured timeout when work does not drain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'afk-managed-loop-'));
    const { providers } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection,
      shutdownTimeoutMs: 10,
      pidFilePath: join(directory, 'loop.pid'),
      statusFilePath: join(directory, 'status.json'),
      readManifest,
    });
    const internals = subject as any;
    internals.running = true;
    internals.inExecution.set('42', { iid: '42', session: '', startedAt: Date.now() });
    internals.emitEvent = vi.fn();
    vi.useFakeTimers();

    try {
      const stopping = subject.stop();
      await vi.advanceTimersByTimeAsync(10);
      await stopping;
      expect(vi.getTimerCount()).toBe(0);
      expect(internals.emitEvent).toHaveBeenCalledWith(expect.stringContaining('shutdown timeout: execution=1'));
      expect(subject.getStatus().execution).toEqual({ active: 1, ids: ['42'] });
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not start polling after a shutdown during startup validation', async () => {
    const { providers, backlog } = providersFor();
    let finish!: (manifest: Awaited<ReturnType<typeof readManifest>>) => void;
    const subject = new LoopRunner(providers, {
      ...selection,
      readManifest: () => new Promise(resolve => { finish = resolve; }),
    });
    const starting = subject.start();
    await subject.stop();
    finish(await readManifest());
    await starting;
    expect(backlog.list).not.toHaveBeenCalled();
    expect(backlog.claim).not.toHaveBeenCalled();
  });

  it('stops after one published execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'afk-managed-loop-'));
    const { providers } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection, maxIterations: 1, pollIntervalMs: 60_000, statusIntervalMs: 60_000,
      pidFilePath: join(directory, 'loop.pid'), statusFilePath: join(directory, 'status.json'), readManifest,
      executeManagedWorkItem: vi.fn(async () => ({ status: 'merge_ready' } as any)),
    });
    try {
      await subject.start();
      expect(subject.getStatus().totals).toMatchObject({ completed: 1, failed: 0, started: 1 });
      expect(subject.getStatus().execution.active).toBe(0);
    } finally {
      await subject.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

});

describe('LoopRunner exits when the work item leaves machine states', () => {
  it.each(['merge_ready', 'done', 'blocked'] as const)('stops when the item is %s', async state => {
    const { providers, backlog } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection, readManifest,
      executeManagedWorkItem: vi.fn(async () => {
        (backlog.get as any).mockResolvedValue({ ...item, state });
        return { status: 'merge_ready' } as any;
      }),
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    const stop = vi.spyOn(subject, 'stop').mockResolvedValue();
    await internals.runManagedChain('42');
    expect(stop).toHaveBeenCalledWith('work-left-machine');
  });

  it.each(['rework', 'ready'] as const)('keeps polling when the item is back to %s', async state => {
    const { providers, backlog } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection, readManifest,
      executeManagedWorkItem: vi.fn(async () => {
        (backlog.get as any).mockResolvedValue({ ...item, state });
        return { status: 'rework' } as any;
      }),
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    const stop = vi.spyOn(subject, 'stop').mockResolvedValue();
    await internals.runManagedChain('42');
    expect(stop).not.toHaveBeenCalled();
    await internals.poll();
    expect(backlog.list).toHaveBeenCalledWith({ state: 'rework', executionMode: 'afk' });
  });

  it('does not exit when the state read fails; records the error', async () => {
    const { providers, backlog } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection, readManifest,
      executeManagedWorkItem: vi.fn(async () => {
        (backlog.get as any).mockRejectedValue(new Error('503'));
        return { status: 'rework' } as any;
      }),
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    const stop = vi.spyOn(subject, 'stop').mockResolvedValue();
    await internals.runManagedChain('42');
    expect(stop).not.toHaveBeenCalled();
    expect(subject.getStatus().lastError['42']).toMatch(/503/);
  });

  it('still stops after N successful completions', async () => {
    const { providers } = providersFor();
    const subject = new LoopRunner(providers, {
      ...selection, readManifest, maxIterations: 1,
      executeManagedWorkItem: vi.fn(async () => ({ status: 'merge_ready' } as any)),
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    const stop = vi.spyOn(subject, 'stop').mockResolvedValue();
    await internals.runManagedChain('42');
    expect(stop).toHaveBeenCalledWith('max-iterations');
  });
});
