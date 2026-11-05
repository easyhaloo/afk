import { availableParallelism, loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { evaluateRunnability, type Runnability } from '../../domain/backlog/runnability.js';
import { prdBaselineForParent } from '../../domain/backlog/prd-baseline.js';
import { findDependencyCycle } from '../../domain/backlog/graph.js';
import { collectGlobalWorkItemInventory } from '../../infrastructure/provider/inventory.js';
import { createGlobalWorkItemCatalogs } from '../../infrastructure/provider/tracker-provider-factory.js';
import { executionManifestPath } from '../../infrastructure/workspace.js';
import { readExecutionManifest } from '../workflows/execution-manifest.js';
import { executeWorkItem, type ExecuteWorkItemResult } from '../workflows/execute-work-item.js';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import { repositoryLeaseKey } from '../../infrastructure/git/repository-lease.js';
import type { WorkItemPlatform } from '../../domain/work-item/identity.js';

export interface ScheduleOptions {
  parent: string;
  maxConcurrent?: number;
  loadLimit?: number;
  pollIntervalMs?: number;
  watch?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  onStatus?: (status: { active: number; capacity: number; overloaded: boolean }) => void;
}

export interface ScheduleResult {
  parent: string;
  /**
   * The branch the PRD accumulates its slices on.
   *
   * Every slice of a PRD is written on this branch and merges into it, so
   * the schedule names the branch the whole PRD lands on.
   */
  baselineBranch?: string;
  capacity: number;
  executions: Array<ExecuteWorkItemResult & { error?: string }>;
  waiting: Array<{ workItemId: string; runnability: Runnability }>;
  stopped: boolean;
  waves?: string[][];
}

export function scheduledDescendants(items: readonly GlobalWorkItem[], parent: string): GlobalWorkItem[] {
  if (!items.some(item => item.id === parent)) throw new Error(`schedule parent is absent from inventory: ${parent}`);
  const selected = new Set([parent]);
  let added = true;
  while (added) {
    added = false;
    for (const item of items) {
      if (!item.parentId || !selected.has(item.parentId) || selected.has(item.id)) continue;
      selected.add(item.id);
      added = true;
    }
  }
  if (items.some(item => item.id === parent && item.parentId && selected.has(item.parentId))) throw new Error('schedule parent hierarchy contains a cycle');
  return items.filter(item => item.id !== parent && selected.has(item.id));
}

export function schedulerCapacity(repositoryCount: number, cores: number, explicit?: number): number {
  if (explicit !== undefined && (!Number.isSafeInteger(explicit) || explicit < 1)) throw new Error('maxConcurrent must be a positive integer');
  return Math.max(1, Math.min(Math.max(1, repositoryCount), explicit ?? Math.max(2, Math.floor(cores / 3))));
}

async function inventory(platform: WorkItemPlatform): Promise<GlobalWorkItem[]> {
  const result = await collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
  if (!result.complete) throw new Error(`schedule inventory is incomplete: ${result.diagnostics.map(diagnostic => diagnostic.message).join('; ')}`);
  return result.items;
}

async function repositoryKeys(item: GlobalWorkItem): Promise<string[]> {
  try {
    const manifest = await readExecutionManifest(executionManifestPath(item.id), item.id);
    return manifest.repositories.map(repository => `${repository.platform}:${repository.projectKey}`);
  } catch (error) {
    if (!(error instanceof Error) || (error.cause as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
    return [`${item.project.platform}:${item.project.projectKey}`];
  }
}

export async function scheduleWorkItems(options: ScheduleOptions, dependencies: {
  inventory?: () => Promise<GlobalWorkItem[]>;
  execute?: (input: { workItemId: string }) => Promise<ExecuteWorkItemResult>;
  repositories?: (item: GlobalWorkItem) => Promise<string[]>;
  cores?: number;
  load?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxReworkAttempts?: number;
} = {}): Promise<ScheduleResult> {
  const parent = parseWorkItemId(options.parent).id;
  const cores = dependencies.cores ?? availableParallelism();
  const loadLimit = options.loadLimit ?? cores;
  const pollInterval = options.pollIntervalMs ?? 5000;
  if (!Number.isFinite(loadLimit) || loadLimit <= 0 || !Number.isFinite(pollInterval) || pollInterval <= 0) throw new Error('scheduler load limit and poll interval must be positive');
  const read = dependencies.inventory ?? (() => inventory(parseWorkItemId(parent).platform));
  const execute = dependencies.execute ?? executeWorkItem;
  const repositories = dependencies.repositories ?? repositoryKeys;
  const maxAttempts = dependencies.maxReworkAttempts ?? getWorkflowConfig().maxQaReworkAttempts;
  const attempts = new Map<string, number>();
  const terminal = new Map<string, ExecuteWorkItemResult['status']>();
  const observed = new Map<string, GlobalWorkItem['state']>();
  const active = new Map<string, { keys: string[]; promise: Promise<void> }>();
  const result: ScheduleResult = { parent, capacity: 1, executions: [], waiting: [], stopped: false };
  try {
    while (!options.signal?.aborted) {
      const items = await read();
      const parentItem = items.find(item => item.id === parent);
      if (parentItem) result.baselineBranch = prdBaselineForParent(parentItem);
      const selected = scheduledDescendants(items, parent);
      for (const item of selected) {
        if (terminal.has(item.id) && observed.has(item.id) && observed.get(item.id) !== item.state
          && (item.state === 'ready' || item.state === 'rework')) {
          terminal.delete(item.id);
          attempts.delete(item.id);
        }
        observed.set(item.id, item.state);
      }
      const byId = new Map(items.map(item => [item.id, item]));
      for (const item of selected) {
        if (await findDependencyCycle(item.id, item.dependsOn, async id => byId.get(id)?.dependsOn ?? [])) throw new Error(`dependency cycle involving ${item.id}`);
      }
      const keys = new Map(await Promise.all(selected.map(async item => [item.id, (await repositories(item)).map(repositoryLeaseKey)] as const)));
      result.capacity = schedulerCapacity(new Set([...keys.values()].flat()).size, cores, options.maxConcurrent);
      const overloaded = (dependencies.load ?? (() => loadavg()[0]))() > loadLimit;
      options.onStatus?.({ active: active.size, capacity: result.capacity, overloaded });
      if (options.dryRun) {
        const completed = new Set(items.filter(item => item.state === 'done').map(item => item.id));
        result.waves = [];
        while (true) {
          const wave: GlobalWorkItem[] = [];
          const occupied = new Set<string>();
          for (const item of selected) {
            if (completed.has(item.id) || wave.length >= result.capacity) continue;
            const runnable = evaluateRunnability({ container: item.kind === 'prd', state: item.state,
              executionMode: item.executionMode, executionEligible: item.managed && item.executionEligible,
              hasChildren: items.some(child => child.parentId === item.id),
              dependencies: item.dependsOn.map(id => ({ id, state: completed.has(id) ? 'done' : byId.get(id)?.state })),
            });
            if (!runnable.runnable || keys.get(item.id)!.some(key => occupied.has(key))) continue;
            wave.push(item);
            for (const key of keys.get(item.id)!) occupied.add(key);
          }
          if (!wave.length) break;
          result.waves.push(wave.map(item => item.id));
          for (const item of wave) completed.add(item.id);
        }
        result.waiting = selected.filter(item => item.state !== 'done' && item.kind !== 'prd' && !completed.has(item.id)).map(item => ({
          workItemId: item.id, runnability: evaluateRunnability({ container: false, state: item.state,
            executionMode: item.executionMode, executionEligible: item.managed && item.executionEligible,
            hasChildren: items.some(child => child.parentId === item.id),
            dependencies: item.dependsOn.map(id => ({ id, state: completed.has(id) ? 'done' : byId.get(id)?.state })),
          }),
        }));
        return result;
      }
      result.waiting = [];
      for (const item of selected) {
        if (item.state === 'done' || item.kind === 'prd' || active.has(item.id)) continue;
        const runnability = evaluateRunnability({ container: false, state: terminal.get(item.id) ?? item.state,
          executionMode: item.executionMode, executionEligible: item.managed && item.executionEligible,
          hasChildren: items.some(child => child.parentId === item.id),
          dependencies: item.dependsOn.map(id => ({ id, state: byId.get(id)?.state })),
        });
        if (!runnability.runnable || terminal.has(item.id) || (attempts.get(item.id) ?? 0) >= maxAttempts) {
          result.waiting.push({ workItemId: item.id, runnability });
          continue;
        }
        const itemKeys = keys.get(item.id)!;
        if (overloaded || active.size >= result.capacity || [...active.values()].some(entry => entry.keys.some(key => itemKeys.includes(key)))) {
          result.waiting.push({ workItemId: item.id, runnability });
          continue;
        }
        attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
        const promise = Promise.resolve().then(() => execute({ workItemId: item.id })).then(execution => {
          result.executions.push(execution);
          if (execution.status !== 'rework') terminal.set(item.id, execution.status);
        }, error => {
          result.executions.push({ workItemId: item.id, executionId: '', status: 'blocked', error: String(error) });
          terminal.set(item.id, 'blocked');
        }).finally(() => { active.delete(item.id); });
        active.set(item.id, { keys: itemKeys, promise });
      }
      if (active.size) {
        await Promise.race([...active.values()].map(entry => entry.promise));
        continue;
      }
      if (!result.waiting.length || (!options.watch && (!overloaded || !result.waiting.some(item => item.runnability.runnable)))) break;
      try {
        if (dependencies.wait) await dependencies.wait(pollInterval, options.signal);
        else await delay(pollInterval, undefined, { signal: options.signal });
      } catch (error) { if (!options.signal?.aborted) throw error; }
    }
  } finally {
    await Promise.all([...active.values()].map(entry => entry.promise));
    result.stopped = options.signal?.aborted ?? false;
  }
  return result;
}
