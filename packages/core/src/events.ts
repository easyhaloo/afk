import type { Run, RunPhase, RunStatus } from './model.js';

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

export interface AgentToolCallSummary {
  id: string;
  name: string;
  result: 'succeeded' | 'failed' | 'unknown' | 'in_progress';
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/**
 * A machine-readable failure code.
 *
 * The code is the stable identity of a failure: the same code always names the
 * same kind of failure, so a tool can branch on it without parsing prose. The
 * human-readable reason stays in `summary` / `reason`.
 *
 * The vocabulary separates three kinds of fact, because "the work failed" and
 * "the machine that runs the work failed" need different responses:
 *
 * - the work failed (a verdict the agent reached, a budget that ran out),
 * - the agent run went wrong (silent, gone, no result),
 * - an external dependency failed (the model service, the transport),
 * - AFK's own execution plumbing failed (setup, crash, publication).
 */
export type RunFailureReasonCode =
  | 'qa_timeout'
  | 'qa_execution_failed'
  | 'qa_rework'
  | 'provider_change_unconfirmed'
  | 'merge_conflict'
  /** The machine cannot run the acceptance criteria's own check commands. */
  | 'qa_environment_missing'
  /**
   * The prompt AFK built is longer than the provider accepts on its goal
   * channel. Detected before the agent was dispatched.
   */
  | 'prompt_budget_exceeded'
  /** The agent died or stopped answering, and the attempt was retried. */
  | 'agent_turn_failed'
  /** The agent said nothing for longer than it was allowed to. */
  | 'agent_idle_timeout'
  /** The agent did not finish within the completion budget. */
  | 'agent_completion_timeout'
  /** The agent did not finish within the hard budget; the session was killed. */
  | 'agent_hard_timeout'
  /** The agent session went away before it reported completion. */
  | 'agent_session_ended'
  /** The completion signal did not match the expected protocol. */
  | 'agent_signal_mismatch'
  /** The agent ended without producing the expected result. */
  | 'agent_missing_result'
  /** The agent process exited with a non-zero status. */
  | 'agent_process_failed'
  /** The agent process could not be started. */
  | 'agent_spawn_failed'
  /** The agent execution was interrupted before it reported completion. */
  | 'agent_interrupted'
  /** The agent execution failed for a reason the vocabulary does not name. */
  | 'agent_execution_failed'
  /** The model service reported an error (for example, an overload). */
  | 'upstream_model_error'
  /** The transport to the agent closed before the run completed. */
  | 'upstream_transport_closed'
  /** The transport to the agent could not be closed cleanly. */
  | 'upstream_transport_close_failed'
  /** The agent reported that it could not do the work. */
  | 'work_reported_failure'
  /** An acceptance criterion did not hold. */
  | 'acceptance_criteria_failed'
  /** The work item ran out of budget. */
  | 'budget_exhausted'
  /** The work item ran out of handoff budget. */
  | 'handoff_budget_exhausted'
  /** The workflow could not be set up. */
  | 'workflow_setup'
  /** The workflow threw unexpectedly. */
  | 'workflow_crash'
  /** The change request could not be published. */
  | 'repository_publication';

/**
 * A snapshot of the failure that came before this one.
 *
 * The chain is what keeps the *first* failure from being lost: every later
 * failure points back at the one before it, so the root cause stays
 * reachable even after secondary information arrives.
 */
export interface FailureCauseSnapshot {
  code: string;
  class: string;
  message: string;
  at?: string;
  cause?: FailureCauseSnapshot;
}

/** One piece of structured evidence behind a failure. */
export interface FailureEvidenceEntry {
  /** What kind of evidence this is: a probe, a command, a timeout, output. */
  kind: string;
  /** A short human label, e.g. `agent output (last 40 lines)`. */
  label: string;
  /** What was expected, when the evidence compares against a requirement. */
  expected?: string;
  /** What was actually seen. */
  actual?: string;
  /** The command that produced the evidence. */
  command?: string;
  /** The exit code of that command. */
  exitCode?: number;
  /** The evidence itself, truncated when it is long. */
  detail?: string;
  /** True when `detail` was cut to fit the size limit. */
  truncated?: boolean;
}

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
  | { kind: 'qa.failed'; reason?: string; reasonCode?: RunFailureReasonCode; summary?: string; failedCriteria?: Array<{ id: string; expected: string; actual: string }>; evidence?: FailureEvidenceEntry[] }
  | { kind: 'change.published'; changeId: string; url: string }
  | { kind: 'decision.made'; command: string; accepted: boolean; reason?: string }
  | { kind: 'effect.started'; effectKind: string; idempotencyKey: string }
  | { kind: 'effect.completed'; effectKind: string; idempotencyKey: string; outcome: 'succeeded' | 'failed'; summary?: string }
  | { kind: 'step.started'; stepId: string; phase: RunPhase }
  | { kind: 'step.completed'; stepId: string; outcome: 'succeeded' | 'failed' }
  | { kind: 'human_gate.opened'; gateId: string; reason: string }
  | { kind: 'human_gate.approved'; gateId: string; approverId: string }
  | { kind: 'run.finished'; outcome: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>; reason?: string; reasonCode?: RunFailureReasonCode }
  | { kind: 'failure.classified'; failureClass: string; summary: string; code?: RunFailureReasonCode; cause?: FailureCauseSnapshot; evidence?: FailureEvidenceEntry[] }
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
