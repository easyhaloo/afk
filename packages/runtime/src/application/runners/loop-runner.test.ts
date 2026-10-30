import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopRunner } from './loop-runner.js';
import { logger } from '../../infrastructure/io/index.js';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import type { BacklogItem } from '../../domain/backlog/index.js';

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
    isRunnable: vi.fn(async () => true),
    explainRunnability: vi.fn(async () => ({ runnable: true, blockedBy: [] })),
    transition: vi.fn(async () => undefined),
    claim: vi.fn(),
  };
  const changes = { findForBacklog: vi.fn(async () => null) };
  return { providers: { backlog, branches: {}, changes } as unknown as ProviderBundle, backlog, changes };
}

describe('LoopRunner manifest-bound execution', () => {
  it('rejects an ambiguous scope before any provider operation', () => {
    const { providers, backlog } = providersFor();
    expect(() => new LoopRunner(providers)).toThrow(/exactly one backlog ID and one work item ID/);
    expect(() => new LoopRunner(providers, { backlogIds: ['42'] })).toThrow(/exactly one backlog ID and one work item ID/);
    expect(() => new LoopRunner(providers, { ...selection, backlogIds: ['42', '43'] })).toThrow(/exactly one/);
    expect(backlog.list).not.toHaveBeenCalled();
  });

  it('derives the manifest from the work item when none is named', async () => {
    const { providers, backlog } = providersFor([{ ...item, state: 'rework' as const }]);
    const executeManagedWorkItem = vi.fn(async () => ({ status: 'merge_ready' } as any));
    const subject = new LoopRunner(providers, {
      ...selection,
      managedExecution: { workItemId: 'github:org/repo#42' },
      readManifest,
      executeManagedWorkItem,
    });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    await internals.poll();
    await vi.waitFor(() => expect(subject.getStatus().totals.completed).toBe(1));

    // No manifest was named, so the execution derives one from the work item
    // instead of being handed a path that does not exist.
    expect(executeManagedWorkItem).toHaveBeenCalledWith({
      workItemId: 'github:org/repo#42', template: undefined,
    });
    expect(backlog.list).toHaveBeenCalled();
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

  it('executes the manifest-bound work item when the provider lists canonical ids', async () => {
    // A real tracker provider lists every backlog item under its canonical
    // global id, while the loop scope carries the provider backlog id.
    const canonical = {
      ...item, id: 'github:org/repo#42', workItemId: 'github:org/repo#42', providerRef: 'github:org/repo#42',
    };
    const { providers } = providersFor([canonical]);
    const executeManagedWorkItem = vi.fn(async () => ({ status: 'merge_ready' } as any));
    const subject = new LoopRunner(providers, { ...selection, readManifest, executeManagedWorkItem });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.poll();

    await vi.waitFor(() => expect(subject.getStatus().totals.completed).toBe(1));
    expect(executeManagedWorkItem).toHaveBeenCalledOnce();
  });

  it('completes a merged backlog during the poll without merging the change itself', async () => {
    const merged = { ...item, state: 'merge_ready' as const, executionMode: 'hitl' as const };
    const transition = vi.fn(async () => {});
    const findForBacklog = vi.fn(async () => ({
      id: 'pr-42', state: 'merged' as const, sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main',
    }));
    const merge = vi.fn();
    const { providers, backlog } = providersFor([merged]);
    (providers as any).backlog.transition = transition;
    (providers as any).changes = { findForBacklog, merge, get: vi.fn() };
    const subject = new LoopRunner(providers, { ...selection, readManifest, targetBranch: 'main' });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.reconcileMergedChanges();

    expect(transition).toHaveBeenCalledWith('42', 'done', { changeId: 'pr-42' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('leaves an unmerged backlog in the merge gate during the poll', async () => {
    const pending = { ...item, state: 'merge_ready' as const, executionMode: 'hitl' as const };
    const transition = vi.fn(async () => {});
    const merge = vi.fn();
    const { providers } = providersFor([pending]);
    (providers as any).backlog.transition = transition;
    (providers as any).changes = {
      findForBacklog: vi.fn(async () => ({ id: 'pr-42', state: 'open' as const, sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' })),
      merge,
      get: vi.fn(),
    };
    const subject = new LoopRunner(providers, { ...selection, readManifest, targetBranch: 'main' });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();

    await internals.reconcileMergedChanges();

    expect(transition).not.toHaveBeenCalled();
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

  it('takes the default pid and status paths from the environment', () => {
    const previousPid = process.env.AFK_LOOP_PID_FILE;
    const previousStatus = process.env.AFK_LOOP_STATUS_FILE;
    process.env.AFK_LOOP_PID_FILE = '/tmp/afk-loop-side-by-side/loop.pid';
    process.env.AFK_LOOP_STATUS_FILE = '/tmp/afk-loop-side-by-side/status.json';
    try {
      const { providers } = providersFor();
      const subject = new LoopRunner(providers, { ...selection, readManifest });
      expect((subject as any).opts.pidFilePath).toBe('/tmp/afk-loop-side-by-side/loop.pid');
      expect((subject as any).opts.statusFilePath).toBe('/tmp/afk-loop-side-by-side/status.json');
    } finally {
      if (previousPid === undefined) delete process.env.AFK_LOOP_PID_FILE;
      else process.env.AFK_LOOP_PID_FILE = previousPid;
      if (previousStatus === undefined) delete process.env.AFK_LOOP_STATUS_FILE;
      else process.env.AFK_LOOP_STATUS_FILE = previousStatus;
    }
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

  it('records why an item was skipped, not only that it was skipped', async () => {
    const { providers, backlog } = providersFor();
    const explanation = { runnable: false, reason: 'dependency_not_done', blockedBy: ['github:org/repo#7'] };
    backlog.explainRunnability = vi.fn(async () => explanation);
    const executeManagedWorkItem = vi.fn();
    const subject = new LoopRunner(providers, { ...selection, readManifest, executeManagedWorkItem });
    const internals = subject as any;
    await internals.validateManagedExecution();
    internals.running = true;
    internals.emitEvent = vi.fn();
    const logged = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    try {
      await internals.poll();
      // The reason reaches the log: without it a log full of "skipped" cannot
      // tell a queue from a deadlock.
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ iid: '42', reason: 'dependency_not_done', blockedBy: ['github:org/repo#7'] }),
        'issue skipped by preconditions',
      );
      expect(executeManagedWorkItem).not.toHaveBeenCalled();
      expect(subject.getStatus().totals.started).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });

  it('returns a claim left behind by a previous run to the queue', async () => {
    const claimed = { ...item, state: 'in_progress' as const };
    const { providers, backlog } = providersFor([claimed]);
    const subject = new LoopRunner(providers, { ...selection, readManifest });
    const internals = subject as any;

    await internals.recoverOrphanedClaims();

    expect(backlog.transition).toHaveBeenCalledWith('42', 'ready');
  });

  it('returns a claim with an open change request as rework, so the change is reused', async () => {
    const claimed = { ...item, state: 'in_progress' as const };
    const { providers, backlog, changes } = providersFor([claimed]);
    changes.findForBacklog = vi.fn(async () => ({ id: '7', state: 'open' }));
    const subject = new LoopRunner(providers, { ...selection, readManifest });
    const internals = subject as any;

    await internals.recoverOrphanedClaims();

    // `rework` is the position whose execution reuses the open change
    // request instead of refusing to open a second one.
    expect(backlog.transition).toHaveBeenCalledWith('42', 'rework');
  });

  it('leaves a claim that belongs to another loop alone', async () => {
    const claimed = { ...item, id: '43', state: 'in_progress' as const };
    const { providers, backlog } = providersFor([claimed]);
    const subject = new LoopRunner(providers, { ...selection, readManifest });
    const internals = subject as any;

    await internals.recoverOrphanedClaims();

    expect(backlog.transition).not.toHaveBeenCalled();
  });

  it('brings back an item that waits for a QA run nobody will run', async () => {
    // The QA run was killed with the process that owned it. Nothing else
    // ever picks the item up again, because a verification waits for a
    // verification.
    const interrupted = { ...item, state: 'verification' as const };
    const { providers, backlog } = providersFor([interrupted]);
    const subject = new LoopRunner(providers, { ...selection, readManifest });
    const internals = subject as any;

    await internals.recoverOrphanedClaims();

    expect(backlog.transition).toHaveBeenCalledWith('42', 'ready');
  });

  it('brings back an interrupted QA as rework when it already has a change request', async () => {
    const interrupted = { ...item, state: 'verification' as const };
    const { providers, backlog, changes } = providersFor([interrupted]);
    changes.findForBacklog = vi.fn(async () => ({ id: '7', state: 'open' }));
    const subject = new LoopRunner(providers, { ...selection, readManifest });
    const internals = subject as any;

    await internals.recoverOrphanedClaims();

    expect(backlog.transition).toHaveBeenCalledWith('42', 'rework');
  });

});
