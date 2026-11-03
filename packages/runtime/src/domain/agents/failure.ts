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
