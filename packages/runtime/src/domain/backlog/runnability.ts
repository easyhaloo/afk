/**
 * Why a work item can or cannot start executing.
 *
 * A state label says where a work item sits in its lifecycle. It does not say
 * why it is not moving: `ready` looks identical whether the item is waiting
 * for a dependency or ready to start. An operator watching a board of `ready`
 * items cannot tell a queue from a deadlock, and a loop that only logs
 * "skipped" leaves the same question open.
 *
 * The rules live here, away from any provider, so the loop, the command line
 * and the desktop client answer "can this run, and if not, why" the same way.
 */

/** Why a work item is not runnable right now. */
export type RunnabilityReason =
  /** The item is a container (a PRD anchor), not executable work. */
  | 'not_execution_eligible'
  /** The item is blocked and waits for a person. */
  | 'blocked_for_human'
  /** AFK is already working on the item. */
  | 'execution_in_progress'
  /** The change passed QA and waits to be merged. */
  | 'awaiting_merge'
  /** The lifecycle position is not one AFK starts work from. */
  | 'state_not_runnable'
  /** A human runs this item, so AFK must not pick it up. */
  | 'execution_mode_hitl'
  /** AFK does not own the lifecycle of this item. */
  | 'not_managed'
  /** The item owns children; the children are the work. */
  | 'has_children'
  /** At least one dependency has not finished. */
  | 'dependency_not_done';

/** The runnability of a work item, and what holds it back. */
export interface Runnability {
  /** Whether AFK may start this item now. */
  runnable: boolean;
  /** The rule that stopped it; undefined when it is runnable. */
  reason?: RunnabilityReason;
  /** The dependencies that have not finished yet. */
  blockedBy: string[];
}

/** The lifecycle positions AFK starts work from. */
export const RUNNABLE_STATES = ['ready', 'rework'] as const;

/**
 * The facts the rules need, gathered from whatever surface asks.
 *
 * The subject is deliberately flat: a provider resolves children and
 * dependencies, a collected inventory resolves them locally, and both hand
 * the same shape to the rules.
 */
export interface RunnabilitySubject {
  /** Whether the item is a container rather than executable work. */
  container: boolean;
  /** The lifecycle position; a PRD anchor has none. */
  state?: string;
  /** Who runs the item. */
  executionMode: string;
  /**
   * Whether the item is executable at all.
   *
   * This flag is derived from the lifecycle position, so it is checked after
   * the position: reporting "not executable" for an item that is merely
   * running would hide the fact that AFK is already on it.
   */
  executionEligible?: boolean;
  /** Whether the item owns children. */
  hasChildren: boolean;
  /** The dependencies and where they stand. */
  dependencies: readonly { id: string; state?: string }[];
}

/**
 * Decide whether a work item may start, and say what holds it back.
 *
 * The order of the rules is part of the contract: the first rule that
 * refuses is the reason reported, and the rules are ordered from the most
 * specific fact to the most general one. An item that is blocked says so
 * before it says that a human runs it, because "blocked" is the fact an
 * operator acts on.
 */
export function evaluateRunnability(subject: RunnabilitySubject): Runnability {
  if (subject.container) {
    return { runnable: false, reason: 'not_execution_eligible', blockedBy: [] };
  }
  if (subject.state === 'blocked') {
    return { runnable: false, reason: 'blocked_for_human', blockedBy: [] };
  }
  if (subject.state === 'in_progress' || subject.state === 'verification') {
    return { runnable: false, reason: 'execution_in_progress', blockedBy: [] };
  }
  if (subject.state === 'merge_ready') {
    return { runnable: false, reason: 'awaiting_merge', blockedBy: [] };
  }
  if (!subject.state || !(RUNNABLE_STATES as readonly string[]).includes(subject.state)) {
    return { runnable: false, reason: 'state_not_runnable', blockedBy: [] };
  }
  if (subject.executionMode !== 'afk') {
    return { runnable: false, reason: 'execution_mode_hitl', blockedBy: [] };
  }
  if (subject.executionEligible === false) {
    return { runnable: false, reason: 'not_managed', blockedBy: [] };
  }
  if (subject.hasChildren) {
    return { runnable: false, reason: 'has_children', blockedBy: [] };
  }
  const blockedBy = subject.dependencies.filter(dependency => dependency.state !== 'done').map(dependency => dependency.id);
  if (blockedBy.length > 0) {
    return { runnable: false, reason: 'dependency_not_done', blockedBy };
  }
  return { runnable: true, blockedBy: [] };
}

/**
 * A human-readable explanation of why an item is not moving.
 *
 * The reason names the rule; the blocked-by names the work that has to
 * finish first. Both are needed: the rule says what kind of wait this is,
 * the identities say who has to act.
 */
export function describeRunnability(runnability: Runnability): string {
  if (runnability.runnable) return 'runnable';
  switch (runnability.reason) {
    case 'not_execution_eligible':
      return 'not executable (container item)';
    case 'blocked_for_human':
      return 'blocked — waiting for a person';
    case 'execution_in_progress':
      return 'AFK is working on it';
    case 'awaiting_merge':
      return 'passed QA — waiting to be merged';
    case 'state_not_runnable':
      return 'not in a startable state';
    case 'execution_mode_hitl':
      return 'run by a human, not by AFK';
    case 'not_managed':
      return 'not managed by AFK';
    case 'has_children':
      return 'owns children; the children are the work';
    case 'dependency_not_done':
      return runnability.blockedBy.length === 1
        ? `waiting for ${runnability.blockedBy[0]}`
        : `waiting for ${runnability.blockedBy.join(', ')}`;
    default:
      return 'not runnable';
  }
}
