import type { BacklogExecutionMode, BacklogState } from './index.js';

/** Canonical-to-provider metadata mapping.  Kept out of application modules. */
export const BACKLOG_METADATA = {
  stateLabels: {
    ready: 'stage::ready-for-issues',
    rework: 'stage::rework',
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

/**
 * The label prefixes AFK metadata owns.
 *
 * A prefix says who owns the labels behind it: the lifecycle position, the
 * execution mode, or the role of the item.
 */
export const BACKLOG_LABEL_PREFIX = {
  state: 'stage::',
  mode: 'mode::',
  kind: 'kind::',
} as const;

/**
 * The roles a provider issue can carry.
 *
 * A role says what an item is, not where it is in a lifecycle. The PRD role
 * marks an organizational parent: it groups children and is never
 * executable. It is deliberately not a state — a container has no lifecycle
 * position of its own.
 */
export const BACKLOG_KIND_LABELS = {
  prd: 'kind::prd',
} as const;

export interface BacklogMetadataLabel {
  name: string;
  color: string;
  description: string;
}

/** Provider-neutral label specifications used by adapters that can provision metadata. */
export function backlogMetadataLabelSpecs(
  metadata: typeof BACKLOG_METADATA = BACKLOG_METADATA,
): BacklogMetadataLabel[] {
  return [
    { name: BACKLOG_KIND_LABELS.prd, color: 'C5DEF5', description: 'Organizational PRD anchor; never executable' },
    { name: metadata.stateLabels.ready, color: '0E8A16', description: 'Ready for AFK execution' },
    { name: metadata.stateLabels.rework, color: 'FBCA04', description: 'QA feedback requires another implementation pass' },
    { name: metadata.stateLabels.in_progress, color: '1D76DB', description: 'AFK implementation is in progress' },
    { name: metadata.stateLabels.verification, color: '5319E7', description: 'Independent QA is in progress' },
    { name: metadata.stateLabels.merge_ready, color: '8250DF', description: 'QA passed; merge is pending' },
    { name: metadata.stateLabels.done, color: '0E8A16', description: 'Backlog is complete' },
    { name: metadata.stateLabels.blocked, color: 'B60205', description: 'Human intervention is required' },
    { name: metadata.executionModeLabels.afk, color: '0052CC', description: 'Automated execution mode' },
    { name: metadata.executionModeLabels.hitl, color: 'D73A4A', description: 'Human-in-the-loop execution mode' },
  ];
}

export interface BacklogProviderCapabilities {
  atomicClaim: boolean;
  tags: boolean;
  initialization: boolean;
}
