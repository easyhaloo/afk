export type WorkState =
  | 'ready'
  | 'claimed'
  | 'implementing'
  | 'verifying'
  | 'merge_ready'
  | 'done'
  | 'blocked'
  | 'cancelled';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type RunPhase = 'implementation' | 'verification' | 'release';

export interface WorkLineage {
  /** Organizational grouping only; it never chooses a Git execution baseline. */
  parentId?: string;
  /** All work items that must reach done before this item becomes runnable. */
  dependsOn: readonly string[];
  /** Explicit unmerged execution baseline for stacked work, when required. */
  baseWorkItemId?: string;
}

export interface WorkItem {
  id: string;
  title: string;
  state: WorkState;
  mode: 'autonomous' | 'human';
  lineage: WorkLineage;
  revision: number;
}

export interface Run {
  id: string;
  workItemId: string;
  profileId: string;
  attempt: number;
  status: RunStatus;
  phase?: RunPhase;
}

export interface RunAggregate {
  run?: Run;
  sequence: number;
  terminal: boolean;
  activeStep?: string;
  humanGateId?: string;
}

export const initialRunAggregate = (): RunAggregate => ({
  sequence: 0,
  terminal: false,
});

export type Effect =
  | { kind: 'start_run'; runId: string }
  | { kind: 'start_step'; runId: string; stepId: string; phase: RunPhase }
  | { kind: 'open_human_gate'; runId: string; gateId: string; reason: string }
  | { kind: 'finish_run'; runId: string; outcome: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'> };

export type RunCommand =
  | { type: 'start'; runId: string }
  | { type: 'start_step'; runId: string; stepId: string; phase: RunPhase }
  | { type: 'request_human_gate'; runId: string; gateId: string; reason: string }
  | { type: 'finish'; runId: string; outcome: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'> };

export interface Decision {
  accepted: boolean;
  reason?: string;
  effects: readonly Effect[];
}

export function decide(state: RunAggregate, command: RunCommand): Decision {
  if (!state.run || state.run.id !== command.runId) {
    return { accepted: false, reason: 'run_not_found', effects: [] };
  }
  if (state.terminal) {
    return { accepted: false, reason: 'run_terminal', effects: [] };
  }

  switch (command.type) {
    case 'start':
      return state.run.status === 'pending'
        ? { accepted: true, effects: [{ kind: 'start_run', runId: command.runId }] }
        : { accepted: false, reason: 'run_not_pending', effects: [] };
    case 'start_step':
      return state.run.status === 'running' && !state.activeStep
        ? { accepted: true, effects: [{ kind: 'start_step', runId: command.runId, stepId: command.stepId, phase: command.phase }] }
        : { accepted: false, reason: 'step_not_runnable', effects: [] };
    case 'request_human_gate':
      return state.run.status === 'running'
        ? { accepted: true, effects: [{ kind: 'open_human_gate', runId: command.runId, gateId: command.gateId, reason: command.reason }] }
        : { accepted: false, reason: 'human_gate_not_runnable', effects: [] };
    case 'finish':
      return state.run.status === 'running' && !state.activeStep
        ? { accepted: true, effects: [{ kind: 'finish_run', runId: command.runId, outcome: command.outcome }] }
        : { accepted: false, reason: 'run_not_finishable', effects: [] };
  }
}
