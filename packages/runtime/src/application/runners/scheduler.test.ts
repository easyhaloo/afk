import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describeScheduleWaitReason, inventoryBackoffMs, scheduleWaitReason, scheduleWorkItems, scheduledDescendants, schedulerCapacity } from './scheduler.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';
import { executionManifestPath } from '../../infrastructure/workspace.js';

function item(project: string, number: number, overrides: Partial<GlobalWorkItem> = {}): GlobalWorkItem {
  const id = parseWorkItemId(`github:${project}#${number}`).id;
  return { id, issueNumber: number, project: { platform: 'github', projectKey: project, name: project },
    title: id, managed: true, executionEligible: true, state: 'ready', executionMode: 'afk',
    dependsOn: [], tags: [], branchName: `afk/${number}`, providerRef: id, ...overrides };
}

describe('scheduler', () => {
  it('uses the item repository when its manifest is absent but rejects an invalid existing manifest', async () => {
    const parent = item('scheduler-test/prd', 1, { kind: 'prd' });
    const child = item('scheduler-test/api', 2, { parentId: parent.id });
    const execute = vi.fn();
    const dependencies = { inventory: async () => [parent, child], execute };
    const options = { parent: parent.id, dryRun: true };
    expect((await scheduleWorkItems(options, dependencies)).waves).toEqual([[child.id]]);
    const manifestPath = executionManifestPath(child.id);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{invalid');
    await expect(scheduleWorkItems(options, dependencies)).rejects.toThrow('invalid JSON');
    expect(execute).not.toHaveBeenCalled();
  });

  it('previews dependency waves without starting work or claiming items', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const first = item('acme/api', 2, { parentId: parent.id });
    const same = item('acme/api', 3, { parentId: parent.id });
    const other = item('acme/web', 4, { parentId: parent.id });
    const dependent = item('acme/worker', 5, { parentId: parent.id, dependsOn: [first.id] });
    const execute = vi.fn();
    const report = await scheduleWorkItems({ parent: parent.id, dryRun: true, maxConcurrent: 2 }, {
      inventory: async () => [parent, first, same, other, dependent], repositories: async subject => [subject.project.projectKey], execute,
    });
    expect(report.waves).toEqual([[first.id, other.id], [same.id, dependent.id]]);
    expect(execute).not.toHaveBeenCalled();
    expect(report.waiting).toEqual([]);
  });
  it('runs disjoint repositories concurrently, serializes shared repositories, and waits for merged dependencies', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd', state: undefined });
    const first = item('acme/api', 2, { parentId: parent.id });
    const sameRepo = item('acme/api', 3, { parentId: parent.id });
    const other = item('acme/web', 4, { parentId: parent.id });
    const dependent = item('acme/worker', 5, { parentId: parent.id, dependsOn: [first.id] });
    const all = [parent, first, sameRepo, other, dependent];
    const running = new Set<string>();
    let peak = 0;
    const starts: string[] = [];
    const result = await scheduleWorkItems({ parent: parent.id, maxConcurrent: 3 }, {
      inventory: async () => all,
      repositories: async subject => [subject.project.projectKey], cores: 12, load: () => 0,
      execute: async ({ workItemId }) => {
        const subject = all.find(candidate => candidate.id === workItemId)!;
        expect(running.has(subject.project.projectKey)).toBe(false);
        expect(subject.dependsOn.every(id => all.find(candidate => candidate.id === id)?.state === 'done')).toBe(true);
        running.add(subject.project.projectKey);
        starts.push(workItemId);
        peak = Math.max(peak, running.size);
        await new Promise(resolve => setImmediate(resolve));
        running.delete(subject.project.projectKey);
        subject.state = 'done';
        return { executionId: workItemId, workItemId, status: 'done' };
      },
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(starts.indexOf(dependent.id)).toBeGreaterThan(starts.indexOf(first.id));
    expect(result.executions).toHaveLength(4);
    expect(result.waiting).toEqual([]);
  });

  it('serializes multi-repository manifests and exposes human merge gates', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const first = item('acme/api', 2, { parentId: parent.id });
    const second = item('acme/web', 3, { parentId: parent.id, dependsOn: [first.id] });
    const third = item('acme/api', 4, { parentId: parent.id });
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => ({ workItemId, executionId: 'attempt', status: 'merge_ready' as const }));
    const result = await scheduleWorkItems({ parent: parent.id }, {
      inventory: async () => [parent, first, second, third], repositories: async () => ['shared', 'other'], execute, load: () => 0,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.waiting.find(entry => entry.workItemId === second.id)?.runnability.blockedBy).toEqual([first.id]);
    expect(result.waiting.find(entry => entry.workItemId === first.id)?.runnability.reason).toBe('awaiting_merge');
  });

  it('pauses launches under load and drains in-flight work on stop', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const controller = new AbortController();
    const load = vi.fn().mockReturnValueOnce(8).mockReturnValue(0);
    const wait = vi.fn(async () => {});
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => {
      controller.abort();
      return { workItemId, executionId: 'attempt', status: 'merge_ready' as const };
    });
    const result = await scheduleWorkItems({ parent: parent.id, loadLimit: 4, signal: controller.signal }, {
      inventory: async () => [parent, child], repositories: async () => ['api'], load, wait, execute,
    });
    // One wait while the machine was overloaded, one re-evaluation timer while
    // the attempt was in flight.
    expect(wait).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(true);
    expect(result.executions).toHaveLength(1);
  });

  it('watches a human gate and accepts an explicit operator retry', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const controller = new AbortController();
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => {
      const status = child.state === 'ready' ? 'merge_ready' as const : 'done' as const;
      child.state = status;
      if (status === 'done') controller.abort();
      return { workItemId, executionId: 'attempt', status };
    });
    const wait = vi.fn(async () => { if (child.state === 'merge_ready') child.state = 'rework'; });
    const report = await scheduleWorkItems({ parent: parent.id, watch: true, signal: controller.signal }, {
      inventory: async () => [parent, child], repositories: async () => ['api'], load: () => 0, execute, wait,
    });
    // A re-evaluation timer for each attempt, and one poll while the merge
    // gate waited for a person.
    expect(wait).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(report.executions.map(execution => execution.status)).toEqual(['merge_ready', 'done']);
    expect(report.waiting).toEqual([]);
  });

  it('fills idle capacity within the poll interval instead of waiting for the running slice to end', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const running = item('acme/base', 2, { parentId: parent.id });
    const released = [
      item('acme/api', 3, { parentId: parent.id, state: 'blocked' }),
      item('acme/web', 4, { parentId: parent.id, state: 'blocked' }),
      item('acme/docs', 5, { parentId: parent.id, state: 'blocked' }),
    ];
    const all = [parent, running, ...released];
    const events: string[] = [];
    let fillIdleSlots!: () => void;
    const idleSlotsFilled = new Promise<void>(resolve => { fillIdleSlots = resolve; });
    let reads = 0;
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => {
      events.push(`start:${workItemId}`);
      if (workItemId === running.id) {
        // The running slice ends only after the idle slots are filled, or
        // after a second — whichever comes first. The second branch is what
        // the old scheduler relied on: it never looked at the schedule again
        // while an execution was in flight.
        let fallback!: NodeJS.Timeout;
        const expires = new Promise<void>(resolve => { fallback = setTimeout(resolve, 1000); fallback.unref?.(); });
        await Promise.race([idleSlotsFilled, expires]);
      } else if (events.filter(event => event.startsWith('start:')).length === 4) {
        fillIdleSlots();
      }
      events.push(`finish:${workItemId}`);
      const subject = all.find(candidate => candidate.id === workItemId)!;
      subject.state = 'done';
      return { workItemId, executionId: 'attempt', status: 'done' as const };
    });
    const inventory = vi.fn(async () => {
      reads += 1;
      // An operator releases the three sibling slices while the first one runs.
      if (reads > 1) for (const subject of released) subject.state = 'ready';
      return all;
    });
    const startedAt = Date.now();
    const report = await scheduleWorkItems({ parent: parent.id, maxConcurrent: 4, pollIntervalMs: 50 }, {
      inventory, repositories: async subject => [subject.project.projectKey], cores: 12, load: () => 0, execute,
    });
    const elapsed = Date.now() - startedAt;
    expect(report.capacity).toBe(4);
    expect(execute).toHaveBeenCalledTimes(4);
    // The three idle slots were filled while the first slice was still
    // running — not after it ended.
    expect(events.indexOf(`start:${released[0].id}`)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(`start:${released[0].id}`)).toBeLessThan(events.indexOf(`finish:${running.id}`));
    expect(elapsed).toBeLessThan(1000);
  });

  it('keeps watching after the work is done, until the schedule is stopped', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const controller = new AbortController();
    let reads = 0;
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => {
      child.state = 'done';
      return { workItemId, executionId: 'attempt', status: 'done' as const };
    });
    const inventory = vi.fn(async () => {
      reads += 1;
      if (reads >= 3) controller.abort();
      return [parent, child];
    });
    const report = await scheduleWorkItems({ parent: parent.id, watch: true, pollIntervalMs: 10, signal: controller.signal }, {
      inventory, repositories: async () => ['api'], load: () => 0, execute,
    });
    // The watch did not end by itself when the waiting list ran empty.
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.stopped).toBe(true);
  });

  it('reports the constraint that keeps each waiting item waiting', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const base = item('acme/base', 2, { parentId: parent.id });
    const sibling = item('acme/web', 3, { parentId: parent.id });
    const dependent = item('acme/api', 4, { parentId: parent.id, dependsOn: [base.id] });
    const human = item('acme/docs', 5, { parentId: parent.id, state: 'merge_ready' });
    const controller = new AbortController();
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => {
      controller.abort();
      return { workItemId, executionId: 'attempt', status: 'merge_ready' as const };
    });
    const result = await scheduleWorkItems({ parent: parent.id, maxConcurrent: 1, signal: controller.signal }, {
      inventory: async () => [parent, base, sibling, dependent, human],
      repositories: async subject => [subject.project.projectKey], load: () => 0, execute,
    });
    const reason = (workItemId: string) => result.waiting.find(entry => entry.workItemId === workItemId)?.waitReason;
    expect(reason(sibling.id)).toBe('capacity_full');
    expect(reason(dependent.id)).toBe('dependency_not_ready');
    expect(reason(human.id)).toBe('awaiting_human');
    // The runnability rules are unchanged; the wait reason is an addition.
    expect(result.waiting.find(entry => entry.workItemId === dependent.id)?.runnability.blockedBy).toEqual([base.id]);
  });

  it('reports an overloaded host as the reason nothing is dispatched', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const controller = new AbortController();
    const execute = vi.fn();
    const result = await scheduleWorkItems({ parent: parent.id, loadLimit: 4, signal: controller.signal }, {
      inventory: async () => { controller.abort(); return [parent, child]; },
      repositories: async () => ['api'], load: () => 8, execute,
    });
    expect(result.waiting.find(entry => entry.workItemId === child.id)?.waitReason).toBe('system_overloaded');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects cycles and invalid budgets before execution', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const first = item('acme/api', 2, { parentId: parent.id });
    first.dependsOn = [first.id];
    const execute = vi.fn();
    await expect(scheduleWorkItems({ parent: parent.id }, { inventory: async () => [parent, first], execute })).rejects.toThrow('cycle');
    expect(execute).not.toHaveBeenCalled();
    expect(schedulerCapacity(10, 12)).toBe(4);
    expect(schedulerCapacity(1, 12)).toBe(1);
    expect(() => schedulerCapacity(2, 4, 0)).toThrow('positive');
    expect(() => scheduledDescendants([], parent.id)).toThrow('absent');
  });

  it('keeps scheduling after one failed inventory read', async () => {
    // One fetch that did not make it through the network is not a verdict
    // on the provider. The old scheduler treated it as one and the whole
    // process died with it.
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const controller = new AbortController();
    let reads = 0;
    const inventory = vi.fn(async () => {
      reads += 1;
      if (reads === 1) throw new Error('schedule inventory is incomplete: fetch failed');
      return [parent, child];
    });
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => {
      controller.abort();
      return { workItemId, executionId: 'attempt', status: 'merge_ready' as const };
    });

    const result = await scheduleWorkItems({ parent: parent.id, watch: true, pollIntervalMs: 10, signal: controller.signal }, {
      inventory, repositories: async () => ['api'], load: () => 0, execute,
    });

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.executions.map(execution => execution.status)).toEqual(['merge_ready']);
  });

  it('retries a failing inventory with a growing backoff instead of exiting', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const controller = new AbortController();
    const failures: number[] = [];
    const statuses: Array<{ failures: number; error: string; retryInMs: number } | undefined> = [];
    const inventory = vi.fn(async () => {
      failures.push(failures.length + 1);
      if (failures.length === 4) controller.abort();
      throw new Error('schedule inventory is incomplete: fetch failed');
    });
    const wait = vi.fn(async () => {});

    const result = await scheduleWorkItems({ parent: parent.id, watch: true, pollIntervalMs: 100, signal: controller.signal,
      onStatus: status => statuses.push(status.inventoryUnavailable) }, {
      inventory, repositories: async () => ['api'], load: () => 0, wait,
    });

    // Four failed reads, and the scheduler is still alive: it never threw.
    expect(failures).toHaveLength(4);
    expect(result.stopped).toBe(true);
    // The backoff grows with every failure, starting at the poll interval.
    expect(wait.mock.calls.map(call => call[0])).toEqual([100, 200, 400, 800]);
    // And it says so: the operator is told the scheduler is running but
    // cannot see the work items.
    expect(statuses).toHaveLength(4);
    expect(statuses[0]).toMatchObject({ failures: 1, retryInMs: 100 });
    expect(statuses[0]!.error).toContain('fetch failed');
    expect(statuses[3]).toMatchObject({ failures: 4, retryInMs: 800 });
  });
});

describe('inventoryBackoffMs', () => {
  it('starts at the poll interval and doubles with every failure', () => {
    expect(inventoryBackoffMs(1, 30_000)).toBe(30_000);
    expect(inventoryBackoffMs(2, 30_000)).toBe(60_000);
    expect(inventoryBackoffMs(3, 30_000)).toBe(120_000);
  });

  it('never waits longer than the ceiling', () => {
    expect(inventoryBackoffMs(10, 30_000)).toBe(300_000);
    expect(inventoryBackoffMs(100, 30_000)).toBe(300_000);
    expect(inventoryBackoffMs(5, 1_000, 4_000)).toBe(4_000);
  });

  it('refuses a nonsensical interval', () => {
    expect(() => inventoryBackoffMs(1, 0)).toThrow('poll interval must be positive');
    expect(() => inventoryBackoffMs(1, 30_000, 0)).toThrow('maximum backoff must be positive');
  });
});

describe('scheduleWaitReason', () => {
  const idle = { overloaded: false, capacityFull: false, repositoryBusy: false, attemptsExhausted: false };

  it('names the constraint that keeps a runnable item waiting', () => {
    expect(scheduleWaitReason({ runnable: true, blockedBy: [] }, { ...idle, capacityFull: true })).toBe('capacity_full');
    expect(scheduleWaitReason({ runnable: true, blockedBy: [] }, { ...idle, repositoryBusy: true })).toBe('repository_busy');
    expect(scheduleWaitReason({ runnable: true, blockedBy: [] }, { ...idle, overloaded: true })).toBe('system_overloaded');
    expect(scheduleWaitReason({ runnable: true, blockedBy: [] }, { ...idle, attemptsExhausted: true })).toBe('attempt_limit_reached');
  });

  it('names the gate that keeps an unrunnable item waiting', () => {
    expect(scheduleWaitReason({ runnable: false, reason: 'dependency_not_done', blockedBy: ['a'] }, idle)).toBe('dependency_not_ready');
    expect(scheduleWaitReason({ runnable: false, reason: 'awaiting_merge', blockedBy: [] }, idle)).toBe('awaiting_human');
    expect(scheduleWaitReason({ runnable: false, reason: 'blocked_for_human', blockedBy: [] }, idle)).toBe('awaiting_human');
    expect(scheduleWaitReason({ runnable: false, reason: 'execution_mode_hitl', blockedBy: [] }, idle)).toBe('awaiting_human');
    expect(scheduleWaitReason({ runnable: false, reason: 'not_managed', blockedBy: [] }, idle)).toBe('not_executable');
    expect(scheduleWaitReason({ runnable: false, reason: 'state_not_runnable', blockedBy: [] }, idle)).toBe('not_executable');
  });

  it('prefers the constraint that binds first', () => {
    // No amount of free capacity starts an item whose dependency is not
    // merged, so the dependency outranks the host.
    expect(scheduleWaitReason({ runnable: false, reason: 'dependency_not_done', blockedBy: ['a'] },
      { ...idle, capacityFull: true, overloaded: true })).toBe('dependency_not_ready');
    // A taken slot is the reason the item waits even on an idle machine.
    expect(scheduleWaitReason({ runnable: true, blockedBy: [] },
      { ...idle, capacityFull: true, overloaded: true })).toBe('capacity_full');
    expect(scheduleWaitReason({ runnable: true, blockedBy: [] },
      { ...idle, repositoryBusy: true, overloaded: true })).toBe('repository_busy');
  });
});

describe('describeScheduleWaitReason', () => {
  it('describes every reason in one line', () => {
    expect(describeScheduleWaitReason('dependency_not_ready')).toBe('waiting for a dependency to finish');
    expect(describeScheduleWaitReason('capacity_full')).toBe('waiting for a free execution slot');
    expect(describeScheduleWaitReason('repository_busy')).toBe('waiting for a repository lease');
    expect(describeScheduleWaitReason('system_overloaded')).toBe('waiting for the system load to drop');
    expect(describeScheduleWaitReason('attempt_limit_reached')).toBe('waiting for an operator retry (attempt budget spent)');
    expect(describeScheduleWaitReason('awaiting_human')).toBe('waiting for a person');
    expect(describeScheduleWaitReason('not_executable')).toBe('not executable by AFK');
  });
});
