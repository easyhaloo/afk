import type { WorkItem, WorkState } from '@afk/core';

/**
 * Adapter boundary: the single backlog -> core vocabulary mapping.
 *
 * Backlog lifecycle names (`in_progress`, `verification`, the `afk` / `hitl`
 * execution modes) are external provider-facing naming. Core must not know
 * them, so the translation lives here at the application boundary and both
 * consumers project through it: the AFK CLI (`src/application`) imports this
 * module directly, and the Electron desktop client reaches it as a value
 * through the pre-bundled `dist-electron/application.cjs`. One table, one
 * place a vocabulary change has to land — see
 * docs/architecture/blueprints/core-layer-architecture_zh.md.
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

export function toCoreWorkState(state: BacklogState): WorkState {
  return coreWorkStateByBacklogState[state];
}

export function toCoreWorkMode(executionMode: BacklogExecutionMode): WorkItem['mode'] {
  return coreWorkModeByExecutionMode[executionMode];
}
