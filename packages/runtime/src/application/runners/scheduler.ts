import { availableParallelism, loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { evaluateRunnability, type Runnability } from '../../domain/backlog/runnability.js';
import { prdBaselineForParent } from '../../domain/backlog/prd-baseline.js';
import { findDependencyCycle } from '../../domain/backlog/graph.js';
import {
  assessScheduleScope,
  computeScheduleScope,
  workItemProjectKey,
} from '../../domain/backlog/schedule-scope.js';
import { collectGlobalWorkItemInventory } from '../../infrastructure/provider/inventory.js';
import { createGlobalWorkItemCatalogs } from '../../infrastructure/provider/tracker-provider-factory.js';
import { executionManifestPath } from '../../infrastructure/workspace.js';
import { logger } from '../../infrastructure/io/logger.js';
import { readExecutionManifest } from '../workflows/execution-manifest.js';
import { executeWorkItem, type ExecuteWorkItemResult } from '../workflows/execute-work-item.js';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import { repositoryLeaseKey } from '../../infrastructure/git/repository-lease.js';
import type { WorkItemPlatform } from '../../domain/work-item/identity.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import type { AgentProviderRegistry } from '../../domain/agents/index.js';
import type { InventoryDiagnostic } from '../../domain/work-item/provider-types.js';

export interface ScheduleOptions {
  parent: string;
  maxConcurrent?: number;
  loadLimit?: number;
  pollIntervalMs?: number;
  watch?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  onStatus?: (status: ScheduleStatus) => void;
}

/**
 * What one read of the world produced.
 *
 * The items and the diagnostics belong together: the diagnostics say which
 * projects could not be read, and a schedule is only as complete as the range
 * it depends on. Reading them separately would let the two drift.
 */
export interface ScheduleInventory {
  /** The work items the provider reported. */
  items: GlobalWorkItem[];
  /** The diagnostics the provider reported alongside them. */
  diagnostics: InventoryDiagnostic[];
}

/**
 * What the scheduler could see, and what it could not.
 *
 * The report is the operator's evidence that the schedule is looking at the
 * right range: the projects outside it that failed anyway, the projects
 * inside it that failed, and the items held back because of it.
 */
export interface ScheduleScopeReport {
  /** Diagnostics outside the scope: named, reported, never fatal. */
  reported: InventoryDiagnostic[];
  /** Diagnostics inside the scope: the scope's own visibility is broken. */
  unreadable: InventoryDiagnostic[];
  /** The items held back because a dependency lives in an unreadable project. */
  heldBack: string[];
}

/**
 * What the scheduler knows about itself right now.
 *
 * The inventory is part of that: a scheduler that cannot read the work
 * items is alive but blind, and an operator has to be able to tell those
 * two apart from a scheduler that has nothing to do.
 */
export interface ScheduleStatus {
  active: number;
  capacity: number;
  overloaded: boolean;
  /**
   * The inventory could not be read. The scheduler is still running and
   * will retry; this says how often it has failed and when it tries next.
   */
  inventoryUnavailable?: { failures: number; error: string; retryInMs: number; permanent?: boolean };
  /**
   * What the scheduler can see of the range it depends on.
   *
   * A scheduler that reads the whole platform and dispatches a subtree has
   * two ranges, and an operator has to be able to tell them apart: the
   * failures outside the scope are reported and harmless, the ones inside it
   * hold work back.
   */
  scope?: ScheduleScopeReport;
}

/**
 * Why the scheduler selected a work item and did not dispatch it.
 *
 * The runnability rules answer "may this item start"; they cannot answer
 * "why is it still waiting", because that also depends on the host: the
 * capacity, the machine load, and the repository leases other executions
 * hold. An operator who sees four waiting items has to know which constraint
 * binds, because "the capacity is full" and "the dependency is not merged"
 * call for completely different actions — and the scheduler used to report
 * both the same way.
 */
export type ScheduleWaitReason =
  /** A dependency has not finished yet. */
  | 'dependency_not_ready'
  /** Every execution slot is taken. */
  | 'capacity_full'
  /** Another execution holds one of this item's repository leases. */
  | 'repository_busy'
  /** The host is above the load limit, so launches are paused. */
  | 'system_overloaded'
  /** A person has to act: a merge, a blocked item, or an operator retry. */
  | 'awaiting_human'
  /** The rework budget for this item is spent. */
  | 'attempt_limit_reached'
  /**
   * AFK cannot see what this item waits for.
   *
   * A project inside the schedule's scope could not be read, so the state of
   * the dependency is unknown. Dispatching on an unknown state is the thing
   * the completeness check exists to prevent, so the item waits.
   */
  | 'visibility_unknown'
  /** AFK does not execute this item at all. */
  | 'not_executable';

/** One selected work item the scheduler did not dispatch. */
export interface ScheduleWaitingItem {
  workItemId: string;
  runnability: Runnability;
  /**
   * Why the item is waiting.
   *
   * Optional on purpose: a report written before this field existed still
   * parses, and a caller that does not know the field is unaffected by it.
   */
  waitReason?: ScheduleWaitReason;
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
  /**
   * The items the scheduler selected but did not dispatch.
   *
   * Each entry says why it is waiting, so an operator can tell a full
   * capacity from an unready dependency.
   */
  waiting: ScheduleWaitingItem[];
  stopped: boolean;
  waves?: string[][];
  /**
   * What the scheduler could see of the range it depends on.
   *
   * The report names the projects outside the scope that failed anyway, the
   * projects inside it that failed, and the items held back because of it.
   */
  scope?: ScheduleScopeReport;
}

/** The facts about the host that decide whether a runnable item can start. */
export interface ScheduleWaitContext {
  /** The machine load is above the configured limit. */
  overloaded: boolean;
  /** Every execution slot is taken. */
  capacityFull: boolean;
  /** Another execution holds one of this item's repository leases. */
  repositoryBusy: boolean;
  /** The item spent its rework budget. */
  attemptsExhausted: boolean;
  /**
   * How the scope's own visibility fails for this item.
   *
   * `unknown` — a project the decision depends on could not be read, so the
   * state AFK would decide on is not known.
   * `unreachable` — the same, and the failure is permanent: a project that is
   * gone does not come back by being retried, so a person has to act.
   */
  visibility?: 'unknown' | 'unreachable';
}

/** The runnability reasons a person has to act on. */
const HUMAN_GATED_REASONS: ReadonlySet<string> = new Set([
  'awaiting_merge',
  'blocked_for_human',
  'execution_mode_hitl',
  'execution_in_progress',
]);

/**
 * Name the constraint that keeps an item from running.
 *
 * The order is the order of how binding the constraint is: a missing
 * dependency outranks everything, because no amount of free capacity starts an
 * item whose dependency is not merged; a taken slot outranks the machine
 * load, because a slot that is occupied is the reason this item waits even on
 * an idle machine; the load comes last, because it is the one constraint that
 * clears on its own.
 */
export function scheduleWaitReason(runnability: Runnability, context: ScheduleWaitContext): ScheduleWaitReason {
  // A scope AFK cannot see outranks every other reason: the rest of the
  // reasons are decisions made on a view that is not there.
  if (context.visibility === 'unreachable') return 'awaiting_human';
  if (context.visibility === 'unknown') return 'visibility_unknown';
  if (runnability.reason === 'dependency_not_done') return 'dependency_not_ready';
  if (!runnability.runnable) {
    if (runnability.reason && HUMAN_GATED_REASONS.has(runnability.reason)) return 'awaiting_human';
    return 'not_executable';
  }
  if (context.attemptsExhausted) return 'attempt_limit_reached';
  if (context.capacityFull) return 'capacity_full';
  if (context.repositoryBusy) return 'repository_busy';
  if (context.overloaded) return 'system_overloaded';
  return 'awaiting_human';
}

/**
 * Explain a wait reason in one line.
 *
 * The report is read by a person deciding what to do next, so the wording
 * names the wait rather than the rule that produced it.
 */
export function describeScheduleWaitReason(reason: ScheduleWaitReason): string {
  switch (reason) {
    case 'dependency_not_ready': return 'waiting for a dependency to finish';
    case 'capacity_full': return 'waiting for a free execution slot';
    case 'repository_busy': return 'waiting for a repository lease';
    case 'system_overloaded': return 'waiting for the system load to drop';
    case 'attempt_limit_reached': return 'waiting for an operator retry (attempt budget spent)';
    case 'awaiting_human': return 'waiting for a person';
    case 'visibility_unknown': return 'the project that holds a dependency cannot be read';
    case 'not_executable': return 'not executable by AFK';
    default: return 'waiting';
  }
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

/**
 * Read the platform the schedule's parent lives on.
 *
 * The read covers every project the credentials reach, because a PRD's
 * slices live in the repositories the work touches. Whether that read is
 * good enough is not a question about the platform — it is a question about
 * the scope, and the caller answers it there.
 */
async function readPlatformInventory(platform: WorkItemPlatform): Promise<ScheduleInventory> {
  const result = await collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
  return { items: result.items, diagnostics: result.diagnostics };
}

/**
 * The longest AFK waits between two attempts to read the inventory.
 *
 * A provider that is down for an hour must not turn into a request every
 * second, and a provider that comes back must not have to wait an hour
 * either. Five minutes is the ceiling: long enough to be polite to a
 * struggling provider, short enough that a recovered one is noticed
 * within the same working session.
 */
export const MAX_INVENTORY_BACKOFF_MS = 300_000;

/**
 * How long to wait before the next attempt to read the inventory.
 *
 * The first retry waits one poll interval — the same rhythm the scheduler
 * already keeps — and every further failure doubles it, up to
 * `MAX_INVENTORY_BACKOFF_MS`.
 *
 * A failed read is not a verdict on the provider: one fetch that did not
 * make it through the network says nothing about the next one. The old
 * scheduler treated it as one, and a single unlucky packet killed the
 * process that was supposed to be watching the PRD.
 */
export function inventoryBackoffMs(failures: number, pollIntervalMs: number, maxMs: number = MAX_INVENTORY_BACKOFF_MS): number {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('poll interval must be positive');
  if (!Number.isFinite(maxMs) || maxMs <= 0) throw new Error('maximum backoff must be positive');
  const attempt = Math.max(1, Math.floor(failures));
  // The exponent is bounded so a long outage cannot overflow into Infinity
  // and turn the backoff into a NaN delay.
  const factor = 2 ** Math.min(attempt - 1, 30);
  return Math.min(Math.max(1, Math.round(pollIntervalMs * factor)), maxMs);
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

/**
 * How the scheduler waits between two evaluations.
 *
 * The same primitive serves the idle scheduler — nothing is running, so the
 * world is polled — and the busy one: work is in flight, so the schedule is
 * re-evaluated on the same interval.
 */
type SchedulerWait = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/**
 * Wait until the scheduler has a reason to look at the world again.
 *
 * Two things can change the dispatch decision: an execution finishes, which
 * frees a slot and may satisfy a dependency, and the world changes outside
 * AFK — a person merges a dependency, an operator marks an item rework. The
 * scheduler therefore races the two: the first execution that ends, or the
 * poll interval elapsing.
 *
 * Waiting for the execution alone left idle slots unused for the whole run.
 * A schedule with capacity four and one slice in flight kept three slots
 * empty until that slice finished, so the PRD moved at the speed of its
 * slowest slice instead of at the speed of the capacity the operator asked
 * for. The timer is also what makes `--watch` honest: a merge that lands
 * while another slice runs stays invisible until the scheduler looks again.
 *
 * The timer is cancelled the moment the race is decided, so an abandoned
 * timer neither keeps the process alive nor fires a poll nobody waits for.
 */
async function awaitDispatchDecision(
  active: Map<string, { keys: string[]; promise: Promise<void> }>,
  pollInterval: number,
  signal: AbortSignal | undefined,
  wait: SchedulerWait,
): Promise<void> {
  const timer = new AbortController();
  const cancel = () => timer.abort();
  if (signal?.aborted) timer.abort();
  else signal?.addEventListener('abort', cancel, { once: true });
  let failure: unknown;
  const elapsed = (async () => {
    try {
      await wait(pollInterval, timer.signal);
    } catch (error) {
      // A cancelled timer is the ordinary way this wait ends; anything else
      // is a real failure of the wait itself.
      if (!timer.signal.aborted) failure = error;
    }
  })();
  try {
    await Promise.race([...[...active.values()].map(entry => entry.promise), elapsed]);
  } finally {
    signal?.removeEventListener('abort', cancel);
    timer.abort();
  }
  if (failure !== undefined) throw failure;
}

export async function scheduleWorkItems(options: ScheduleOptions, dependencies: {
  plugins?: PluginRuntime;
  agentProviderRegistry?: AgentProviderRegistry;
  inventory?: () => Promise<ScheduleInventory>;
  execute?: (input: { workItemId: string }) => Promise<ExecuteWorkItemResult>;
  repositories?: (item: GlobalWorkItem) => Promise<string[]>;
  cores?: number;
  load?: () => number;
  wait?: SchedulerWait;
  maxReworkAttempts?: number;
} = {}): Promise<ScheduleResult> {
  const parent = parseWorkItemId(options.parent).id;
  const cores = dependencies.cores ?? availableParallelism();
  const loadLimit = options.loadLimit ?? cores;
  const pollInterval = options.pollIntervalMs ?? 5000;
  if (!Number.isFinite(loadLimit) || loadLimit <= 0 || !Number.isFinite(pollInterval) || pollInterval <= 0) throw new Error('scheduler load limit and poll interval must be positive');
  const read = dependencies.inventory ?? (() => readPlatformInventory(parseWorkItemId(parent).platform));
  const execute = dependencies.execute ?? ((input: { workItemId: string }) => executeWorkItem(input, {
    plugins: dependencies.plugins, agentProviderRegistry: dependencies.agentProviderRegistry,
  }));
  const repositories = dependencies.repositories ?? repositoryKeys;
  const wait: SchedulerWait = dependencies.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const maxAttempts = dependencies.maxReworkAttempts ?? getWorkflowConfig().maxQaReworkAttempts;
  const attempts = new Map<string, number>();
  const terminal = new Map<string, ExecuteWorkItemResult['status']>();
  const observed = new Map<string, GlobalWorkItem['state']>();
  const active = new Map<string, { keys: string[]; promise: Promise<void> }>();
  const result: ScheduleResult = { parent, capacity: 1, executions: [], waiting: [], stopped: false };
  // Consecutive failures to read the inventory. The counter decides the
  // backoff and it is reset by the first read that succeeds.
  let inventoryFailures = 0;
  let lastOverloaded = false;
  // What the scheduler can see of the range it depends on. It travels with
  // every status and ends up in the report: it is the operator's evidence
  // that a failure outside the scope did not stop the schedule.
  let scopeReport: ScheduleScopeReport = { reported: [], unreadable: [], heldBack: [] };
  // The scope failure that was written to the log last. A failure that does
  // not change is not logged again: a scheduler that polls every thirty
  // seconds must not fill the log with the same line.
  let lastScopeSignature = '';
  /**
   * Say that the schedule cannot see what it depends on, and wait for the
   * next attempt.
   *
   * A failure that cannot be retried into success is not treated as one:
   * it is escalated — the log says a person has to act, and so does the
   * status. The scheduler still stays up, because the remedy may be a
   * change on the provider side that AFK picks up on the next poll.
   */
  const reportUnavailable = async (message: string, permanent: boolean): Promise<void> => {
    inventoryFailures += 1;
    const retryInMs = inventoryBackoffMs(inventoryFailures, pollInterval);
    const payload = { parent, failures: inventoryFailures, retryInMs, error: message, permanent };
    if (permanent) {
      logger.error(payload, 'the schedule cannot see what it depends on and the failure is permanent; a person has to act');
    } else {
      logger.warn(payload, 'schedule inventory is unavailable; the scheduler is still running and will retry');
    }
    options.onStatus?.({
      active: active.size, capacity: result.capacity, overloaded: lastOverloaded,
      inventoryUnavailable: { failures: inventoryFailures, error: message, retryInMs, permanent },
      scope: scopeReport,
    });
    try {
      await wait(retryInMs, options.signal);
    } catch (waitError) {
      if (!options.signal?.aborted) throw waitError;
    }
  };
  try {
    while (!options.signal?.aborted) {
      let inventory: ScheduleInventory;
      try {
        inventory = await read();
      } catch (error) {
        // A failed read is not a verdict on the provider. The scheduler
        // stays up, says that it is alive but blind, and tries again after
        // a backoff — the same rhythm it keeps between two evaluations.
        const message = error instanceof Error ? error.message : String(error);
        await reportUnavailable(message, false);
        continue;
      }
      inventoryFailures = 0;
      const items = inventory.items;
      // The range this schedule depends on: the parent PRD, its slices, and
      // what those wait for. A failure outside that range says nothing about
      // the work; a failure inside it means AFK does not know what it is
      // deciding about.
      const scope = computeScheduleScope(items, parent);
      const assessment = assessScheduleScope(scope, inventory.diagnostics);
      const unreadable = new Map<string, boolean>();
      for (const diagnostic of assessment.blocking) {
        if (diagnostic.code === 'project_list_failed') continue;
        unreadable.set(diagnostic.projectKey, !diagnostic.retryable);
      }
      // A project list failure means AFK could not enumerate the candidate
      // projects, so it cannot know which of them the PRD reaches: nothing
      // inside the scope can be decided.
      const membership = assessment.blocking.filter(diagnostic => diagnostic.code === 'project_list_failed');
      const membershipUnknown = membership.length > 0;
      const membershipPermanent = membershipUnknown && membership.every(diagnostic => !diagnostic.retryable);
      /**
       * How the scope's own visibility fails for one item.
       *
       * An item is blind when a project it depends on could not be read: the
       * state AFK would dispatch on is not known. An item that depends on a
       * project that is gone is not merely unknown — nothing will make it
       * known, so a person has to act.
       */
      const visibilityOf = (item: GlobalWorkItem): 'unknown' | 'unreachable' | undefined => {
        if (membershipUnknown) return membershipPermanent ? 'unreachable' : 'unknown';
        const invisible = item.dependsOn
          .map(id => unreadable.get(workItemProjectKey(id) ?? ''))
          .filter((permanent): permanent is boolean => permanent !== undefined);
        if (!invisible.length) return undefined;
        return invisible.some(permanent => permanent) ? 'unreachable' : 'unknown';
      };
      const heldBack: string[] = [];
      scopeReport = { reported: assessment.reported, unreadable: assessment.blocking, heldBack };
      result.scope = scopeReport;
      const scopeSignature = [...assessment.blocking, ...assessment.reported]
        .map(diagnostic => `${diagnostic.platform}:${diagnostic.projectKey}:${diagnostic.code}:${diagnostic.message}`)
        .join('|');
      if (scopeSignature !== lastScopeSignature) {
        lastScopeSignature = scopeSignature;
        for (const diagnostic of assessment.reported) {
          // Outside the scope: named and reported, never fatal. The schedule
          // is about the PRD, not about every project the credentials reach.
          logger.warn({ parent, platform: diagnostic.platform, projectKey: diagnostic.projectKey,
            code: diagnostic.code, message: diagnostic.message },
            'a project outside the schedule scope could not be read; the schedule continues');
        }
        for (const diagnostic of assessment.blocking) {
          logger.error({ parent, platform: diagnostic.platform, projectKey: diagnostic.projectKey,
            code: diagnostic.code, message: diagnostic.message, retryable: diagnostic.retryable },
            'a project inside the schedule scope could not be read; the work that depends on it is held back');
        }
      }
      const anchor = parseWorkItemId(parent);
      const parentItem = items.find(item => item.id === parent);
      if (!parentItem) {
        // The parent is the anchor of the scope. Without it AFK knows
        // nothing about this PRD, so the read failed for this schedule —
        // unless the parent simply does not exist, which is a different
        // answer and a different remedy. A project list that could not be
        // read is the same answer: the parent may well be in it.
        const failure = assessment.blocking.find(diagnostic =>
          diagnostic.projectKey === anchor.projectKey || diagnostic.code === 'project_list_failed');
        if (!failure) throw new Error(`schedule parent is absent from inventory: ${parent}`);
        const reason = failure.code === 'project_list_failed'
          ? 'the project list cannot be read, so the schedule parent is unknown'
          : 'the project holding the schedule parent cannot be read';
        await reportUnavailable(`${reason}: ${failure.message}`, !failure.retryable);
        continue;
      }
      result.baselineBranch = prdBaselineForParent(parentItem);
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
      lastOverloaded = overloaded;
      options.onStatus?.({ active: active.size, capacity: result.capacity, overloaded, scope: scopeReport });
      if (options.dryRun) {
        const completed = new Set(items.filter(item => item.state === 'done').map(item => item.id));
        result.waves = [];
        while (true) {
          const wave: GlobalWorkItem[] = [];
          const occupied = new Set<string>();
          for (const item of selected) {
            if (completed.has(item.id) || wave.length >= result.capacity) continue;
            // A blind item is not scheduled: the dry run shows what would
            // happen, and it would not happen.
            if (visibilityOf(item)) continue;
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
        result.waiting = selected.filter(item => item.state !== 'done' && item.kind !== 'prd' && !completed.has(item.id)).map(item => {
          const runnability = evaluateRunnability({ container: false, state: item.state,
            executionMode: item.executionMode, executionEligible: item.managed && item.executionEligible,
            hasChildren: items.some(child => child.parentId === item.id),
            dependencies: item.dependsOn.map(id => ({ id, state: completed.has(id) ? 'done' : byId.get(id)?.state })),
          });
          const visibility = visibilityOf(item);
          if (visibility) heldBack.push(item.id);
          return {
            workItemId: item.id, runnability,
            waitReason: scheduleWaitReason(runnability, { overloaded: false, capacityFull: false, repositoryBusy: false, attemptsExhausted: false, visibility }),
          };
        });
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
        const attemptsExhausted = (attempts.get(item.id) ?? 0) >= maxAttempts;
        // The scope's own visibility comes first: a slice whose dependency
        // lives in a project AFK could not read is not dispatched, because
        // the state it would be dispatched on is not known. The rest of the
        // tree is unaffected — one unreadable project does not paralyze the
        // PRD.
        const visibility = visibilityOf(item);
        if (visibility) {
          heldBack.push(item.id);
          result.waiting.push({ workItemId: item.id, runnability,
            waitReason: scheduleWaitReason(runnability, { overloaded, capacityFull: false, repositoryBusy: false, attemptsExhausted, visibility }) });
          continue;
        }
        if (!runnability.runnable || terminal.has(item.id) || attemptsExhausted) {
          result.waiting.push({ workItemId: item.id, runnability,
            waitReason: scheduleWaitReason(runnability, { overloaded, capacityFull: false, repositoryBusy: false, attemptsExhausted }) });
          continue;
        }
        const itemKeys = keys.get(item.id)!;
        const capacityFull = active.size >= result.capacity;
        const repositoryBusy = [...active.values()].some(entry => entry.keys.some(key => itemKeys.includes(key)));
        if (overloaded || capacityFull || repositoryBusy) {
          result.waiting.push({ workItemId: item.id, runnability,
            waitReason: scheduleWaitReason(runnability, { overloaded, capacityFull, repositoryBusy, attemptsExhausted }) });
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
        // Work is in flight. The scheduler waits for the next reason to
        // re-evaluate — an execution that ends, or the poll interval — so an
        // idle slot is filled as soon as something becomes dispatchable
        // instead of at the end of the slowest slice. An idle slot is
        // wasted capacity, and wasted capacity is a PRD that ships late.
        await awaitDispatchDecision(active, pollInterval, options.signal, wait);
        continue;
      }
      // Nothing is in flight. Without `--watch` the schedule is one-shot: it
      // ends once the current wave is done and nothing further can start.
      // With `--watch` it stays up until it is stopped, because the help
      // promises it keeps watching for merged dependencies and operator
      // retries — a promise the old loop broke as soon as the waiting list
      // ran empty.
      if (!options.watch && (!result.waiting.length || !overloaded || !result.waiting.some(item => item.runnability.runnable))) break;
      try {
        await wait(pollInterval, options.signal);
      } catch (error) { if (!options.signal?.aborted) throw error; }
    }
  } finally {
    await Promise.all([...active.values()].map(entry => entry.promise));
    result.stopped = options.signal?.aborted ?? false;
  }
  return result;
}
