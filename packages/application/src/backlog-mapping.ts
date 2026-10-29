import type { WorkItem, WorkState } from '@afk/core';

/**
 * Adapter boundary: the single backlog -> core vocabulary mapping.
 *
 * Backlog lifecycle names (`in_progress`, `verification`, the `afk` / `hitl`
 * execution modes) are external provider-facing naming. Core must not know
 * them, so the translation lives here at the application boundary and both
 * consumers import it directly: the AFK CLI (`src/application`) and the
 * Electron desktop client, which is ESM like this package. One table, one
 * place a vocabulary change has to land — see
 * docs/architecture/blueprints/core-layer-architecture_zh.md.
 *
 * A PRD parent has no core state: it is a container, and "waiting for its
 * children to be implemented" is not a position in the lifecycle. Its role
 * travels separately — see `coreWorkKindByBacklogKind`.
 */

export const BACKLOG_STATES = [
  'ready',
  'rework',
  'in_progress',
  'verification',
  'merge_ready',
  'done',
  'blocked',
] as const;

export type BacklogState = (typeof BACKLOG_STATES)[number];

export const BACKLOG_EXECUTION_MODES = ['afk', 'hitl'] as const;

export type BacklogExecutionMode = (typeof BACKLOG_EXECUTION_MODES)[number];

export const coreWorkStateByBacklogState = {
  ready: 'ready',
  rework: 'rework',
  in_progress: 'implementing',
  verification: 'verifying',
  merge_ready: 'merge_ready',
  done: 'done',
  blocked: 'blocked',
} as const satisfies Record<BacklogState, WorkState>;

export const coreWorkModeByExecutionMode = {
  afk: 'autonomous',
  hitl: 'human',
} as const satisfies Record<BacklogExecutionMode, WorkItem['mode']>;

/**
 * The roles a backlog item can carry.
 *
 * A role says what kind of item this is, not where it is in a lifecycle. A
 * PRD parent carries the `prd` role: it groups children and is never
 * executable.
 */
export const BACKLOG_KINDS = ['prd'] as const;

export type BacklogKind = (typeof BACKLOG_KINDS)[number];

export const coreWorkKindByBacklogKind = {
  prd: 'prd',
} as const satisfies Record<BacklogKind, NonNullable<WorkItem['kind']>>;

/**
 * Map a backlog state onto its core work state.
 *
 * A PRD anchor has no state, so it has no core work state either. The
 * mapping stays total over the seven real lifecycle positions.
 */
export function toCoreWorkState(state: BacklogState | undefined): WorkState | undefined {
  return state === undefined ? undefined : coreWorkStateByBacklogState[state];
}

export function toCoreWorkMode(executionMode: BacklogExecutionMode): WorkItem['mode'] {
  return coreWorkModeByExecutionMode[executionMode];
}
