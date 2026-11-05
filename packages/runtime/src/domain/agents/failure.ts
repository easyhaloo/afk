/**
 * Agent failures that say nothing about the work.
 *
 * A verdict on the work comes from the agent: it wrote a completion signal,
 * or it did not. These three are not verdicts — the agent was gone, or it
 * stopped talking, or the upstream model service cut the stream mid-turn.
 * The work in the worktree is still there, and the attempt can be repeated.
 *
 * A timeout is not in this set: a timeout says the work did not finish in
 * the budget it was given, which is a fact about the work.
 *
 * This module owns the agent error-code vocabulary. The workflow layer reads
 * it through {@link classifyAgentFailure} instead of inventing a parallel
 * classification, so a provider code keeps its meaning everywhere.
 */

/** The error codes an attempt can be repeated on. */
export const RETRYABLE_AGENT_ERROR_CODES: ReadonlySet<string> = new Set([
  /** Codex reported a turn that ended in an error. */
  'AGENT_TURN_FAILED',
  /** The agent's session went away before it reported completion. */
  'AGENT_GONE',
  /** The agent produced no output for longer than it was allowed to. */
  'AGENT_IDLE',
]);

/**
 * What an agent failure is about.
 *
 * The three kinds need different responses, so they stay apart: a verdict on
 * the work is the work's problem, an agent-run fact says nothing about the
 * work, and an upstream fact is somebody else's outage.
 */
export type AgentFailureKind =
  /** A verdict about the work: the agent said it could not do it. */
  | 'work_verdict'
  /** A fact about how the agent run went: silent, gone, no result. */
  | 'agent_run'
  /** A fact about an external dependency: the model service, the transport. */
  | 'upstream'
  /** The message is captured process output, not a reason. */
  | 'process_output';

/**
 * How each provider error code is to be read.
 *
 * `process_output` is the important one: a non-zero exit carries the
 * process's own output in `error.message`, and that output is the *symptom*.
 * Treating it as the reason is how a pre-commit hook's rejection gets
 * replaced by the tail of a `pnpm` log.
 */
const AGENT_FAILURE_KINDS: Readonly<Record<string, AgentFailureKind>> = {
  /** The model service reported an error — an overload, a refusal. */
  AGENT_ERROR: 'upstream',
  /** The turn's stream was cut before the turn ended. */
  AGENT_TURN_FAILED: 'upstream',
  /** The transport to the agent closed. */
  TRANSPORT_CLOSED: 'upstream',
  /** The transport to the agent could not be closed cleanly. */
  TRANSPORT_CLOSE_FAILED: 'upstream',
  /** The agent's session went away before it reported completion. */
  AGENT_GONE: 'agent_run',
  /** The agent said nothing for longer than it was allowed to. */
  AGENT_IDLE: 'agent_run',
  /** The completion signal did not match the expected protocol. */
  SIGNAL_MISMATCH: 'agent_run',
  /** The agent ended without producing the expected result. */
  MISSING_RESULT: 'agent_run',
  /** The agent process could not be started. */
  SPAWN_ERROR: 'agent_run',
  /** The agent process exited with a non-zero status. */
  NON_ZERO_EXIT: 'process_output',
};

/** How an agent failure is to be read. */
export interface AgentFailureClassification {
  /** What the failure is about. */
  kind: AgentFailureKind;
  /**
   * True when `error.message` holds captured process output rather than a
   * reason. Output is evidence, not a cause.
   */
  messageIsProviderOutput: boolean;
  /** True when repeating the attempt is meaningful. */
  retryable: boolean;
}

/**
 * Classify a failed agent execution.
 *
 * The provider's own code decides. A code the vocabulary does not know is
 * treated as an agent-run fact: it says the run went wrong, not that the
 * work is wrong.
 */
export function classifyAgentFailure(input: { status: string; error?: { code?: string } }): AgentFailureClassification {
  const code = input.error?.code;
  const kind = (code && AGENT_FAILURE_KINDS[code]) || 'agent_run';
  return {
    kind,
    messageIsProviderOutput: kind === 'process_output',
    retryable: isRetryableAgentFailure(input),
  };
}

/**
 * Whether a failed attempt can be repeated.
 *
 * The repetition is bounded by the run's retry budget, so an agent that dies
 * every time ends the run instead of looping.
 */
export function isRetryableAgentFailure(result: { status: string; error?: { code?: string } }): boolean {
  if (result.status !== 'failed') return false;
  const code = result.error?.code;
  return typeof code === 'string' && RETRYABLE_AGENT_ERROR_CODES.has(code);
}
