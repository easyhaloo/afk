import type { BacklogExecutionMode, BacklogState } from './index';

/** Canonical-to-provider metadata mapping.  Kept out of application modules. */
export const BACKLOG_METADATA = {
  stateLabels: {
    ready: 'stage::ready-for-issues',
    in_progress: 'stage::afk-in-progress',
    verification: 'stage::qa',
    merge_ready: 'stage::merge-ready',
    done: 'stage::done',
    blocked: 'stage::blocked',
  } satisfies Record<BacklogState, string>,
  executionModeLabels: {
    afk: 'mode::afk',
    hitl: 'mode::hitl',
  } satisfies Record<BacklogExecutionMode, string>,
} as const;

export interface BacklogProviderCapabilities {
  atomicClaim: boolean;
  tags: boolean;
  initialization: boolean;
}
