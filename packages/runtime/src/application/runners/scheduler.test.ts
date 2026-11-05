import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scheduleWorkItems, scheduledDescendants, schedulerCapacity } from './scheduler.js';
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
    expect(wait).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(true);
    expect(result.executions).toHaveLength(1);
  });

  it('watches a human gate and accepts an explicit operator retry', async () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => {
      child.state = child.state === 'ready' ? 'merge_ready' : 'done';
      return { workItemId, executionId: 'attempt', status: child.state };
    });
    const wait = vi.fn(async () => { child.state = 'rework'; });
    const report = await scheduleWorkItems({ parent: parent.id, watch: true }, {
      inventory: async () => [parent, child], repositories: async () => ['api'], load: () => 0, execute, wait,
    });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(report.executions.map(execution => execution.status)).toEqual(['merge_ready', 'done']);
    expect(report.waiting).toEqual([]);
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
});
