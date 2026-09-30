import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopRunner } from './loop-runner';
import type { ProviderBundle } from '../providers';
import type { BacklogItem } from '../../domain/backlog/index';

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
