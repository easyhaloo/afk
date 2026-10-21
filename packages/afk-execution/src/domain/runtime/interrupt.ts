/**
 * The request that stops a run.
 *
 * A run's agent is a process in a terminal session, and a run lives in
 * another process. Somebody who stops the run from outside - the desktop
 * client, an operator - cannot call into the running agent, so the
 * request has to travel through something both sides can see: a file in
 * the run's own worktree, beside the signal file the agent itself writes.
 *
 * The request names the reason, so the run that is stopped says why it
 * was stopped rather than reporting a crash.
 */

/** The name of the file the request is written to, beside the signal file. */
export const INTERRUPT_REQUEST_FILE = '.afk-interrupt.json';

/**
 * The reasons a run can be asked to stop.
 *
 * A person asked for it. The runtime's own interrupts - a handoff, a
 * timeout, a failure - are not asked for and do not travel this way.
 */
export type InterruptRequestReason = 'manual';

export interface InterruptRequest {
  reason: InterruptRequestReason;
  /** When the request was made, so a late request is not mistaken for a current one. */
  requestedAt: string;
}
