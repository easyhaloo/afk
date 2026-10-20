import type { Run, RunPhase, RunStatus } from './model.js';

export type ObservationActorKind = 'cli' | 'loop' | 'agent' | 'policy' | 'human' | 'system';

/**
 * The profile a run is recorded under when nobody names one.
 *
 * The profile is the reproducible combination a run happened under, and it
 * is part of the signed identity of every event, so the entry points that
 * write an observation context have to agree on it. The audit
 * documentation names this one.
 */
export const DEFAULT_OBSERVATION_PROFILE = 'local';

export interface ObservationContext {
  traceId: string;
  spanId?: string;
  runId: string;
  workItemId: string;
  profileId: string;
  attempt: number;
  leaseEpoch?: number;
  actor: { kind: ObservationActorKind; id: string };
}

export type EvidenceClassification = 'public' | 'internal' | 'sensitive';
export type RedactionStatus = 'not_required' | 'applied' | 'restricted';

export interface AgentToolCallSummary {
  id: string;
  name: string;
  result: 'succeeded' | 'failed' | 'unknown' | 'in_progress';
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export type RunFailureReasonCode =
  | 'qa_timeout'
  | 'qa_execution_failed'
  | 'qa_rework'
  | 'provider_change_unconfirmed';

export interface EvidenceRef {
  uri: string;
  sha256: string;
  mediaType: string;
  classification: EvidenceClassification;
  redactionStatus: RedactionStatus;
}

export type RunEventData =
  | { kind: 'run.requested'; run: Run }
  | { kind: 'run.started' }
  | { kind: 'lease.granted'; leaseId?: string }
  | { kind: 'workspace.prepared'; branch: string; workspace: string; baseBranch: string }
  | { kind: 'workflow.recorded'; name: string; version: 1; steps: Array<{ id: string; kind: 'agent' | 'system'; dependsOn: readonly string[]; provider?: string; executionMode?: 'interactive' | 'batch' }> }
  | { kind: 'change.created'; changeId: string; targetBranch: string; url?: string }
  | { kind: 'change.merge_verified'; changeId: string; targetBranch: string; child?: boolean }
  | { kind: 'qa.started' }
  | { kind: 'commit.recorded'; phase: 'implementation' | 'qa'; commitSha: string; branch: string }
  | { kind: 'implementation.completed' }
  | { kind: 'qa.passed' }
  | { kind: 'qa.failed'; reason?: string; reasonCode?: RunFailureReasonCode; summary?: string; failedCriteria?: Array<{ id: string; expected: string; actual: string }> }
  | { kind: 'change.published'; changeId: string; url: string }
  | { kind: 'decision.made'; command: string; accepted: boolean; reason?: string }
  | { kind: 'effect.started'; effectKind: string; idempotencyKey: string }
  | { kind: 'effect.completed'; effectKind: string; idempotencyKey: string; outcome: 'succeeded' | 'failed'; summary?: string }
  | { kind: 'step.started'; stepId: string; phase: RunPhase }
  | { kind: 'step.completed'; stepId: string; outcome: 'succeeded' | 'failed' }
  | { kind: 'human_gate.opened'; gateId: string; reason: string }
  | { kind: 'human_gate.approved'; gateId: string; approverId: string }
  | { kind: 'run.finished'; outcome: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>; reason?: string; reasonCode?: RunFailureReasonCode }
  | { kind: 'failure.classified'; failureClass: string; summary: string }
  | { kind: 'handoff.performed'; mode: 'auto' | 'terminal'; outcome: 'continued' | 'terminated'; reason?: string }
  | { kind: 'agent.session_recorded'; sessionId: string; transcriptPath?: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; tools?: AgentToolCallSummary[] };

export type RunEventType = RunEventData['kind'];

export interface RunEvent<T extends RunEventData = RunEventData> {
  id: string;
  schemaVersion: 1;
  type: T['kind'];
  sequence: number;
  occurredAt: string;
  observedAt: string;
  context: ObservationContext;
  causationId?: string;
  correlationId: string;
  idempotencyKey?: string;
  data: T;
  evidence?: readonly EvidenceRef[];
  integrity: { prevHash?: string; hash: string };
}

export type UnsignedRunEvent<T extends RunEventData = RunEventData> = Omit<RunEvent<T>, 'integrity'> & {
  integrity?: { prevHash?: string };
};

/** Caller-provided event intent. The EventStore assigns sequence, observedAt, and integrity. */
export type RunEventDraft<T extends RunEventData = RunEventData> = Omit<RunEvent<T>, 'sequence' | 'observedAt' | 'integrity'>;
