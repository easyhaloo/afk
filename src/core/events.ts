import type { Run, RunPhase, RunStatus } from './model';

export type ObservationActorKind = 'cli' | 'loop' | 'agent' | 'policy' | 'human' | 'system';

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
  | { kind: 'change.created'; changeId: string; targetBranch: string; url?: string }
  | { kind: 'change.merge_verified'; changeId: string; targetBranch: string }
  | { kind: 'decision.made'; command: string; accepted: boolean; reason?: string }
  | { kind: 'effect.started'; effectKind: string; idempotencyKey: string }
  | { kind: 'effect.completed'; effectKind: string; idempotencyKey: string; outcome: 'succeeded' | 'failed'; summary?: string }
  | { kind: 'step.started'; stepId: string; phase: RunPhase }
  | { kind: 'step.completed'; stepId: string; outcome: 'succeeded' | 'failed' }
  | { kind: 'human_gate.opened'; gateId: string; reason: string }
  | { kind: 'human_gate.approved'; gateId: string; approverId: string }
  | { kind: 'run.finished'; outcome: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>; reason?: string }
  | { kind: 'failure.classified'; failureClass: string; summary: string };

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

