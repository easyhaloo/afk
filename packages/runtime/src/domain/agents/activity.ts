/**
 * When the agent last did something.
 *
 * An agent that dies — a crashed TUI, a disconnected stream — leaves the
 * runner waiting for a completion signal that can never arrive, and the
 * wait runs until the hard timeout. Watching the agent's own output tells
 * the two cases apart: a slow agent keeps producing output, a dead one goes
 * silent.
 *
 * The fingerprint is whatever the transport can show cheaply — the tail of
 * a stream, the visible pane of a terminal. It only has to change when the
 * agent does something, not to describe what it did.
 */
export class ActivityWatch {
  private fingerprint = '';
  private lastActivityAtMs: number;

  constructor(private readonly clock: () => number = Date.now) {
    this.lastActivityAtMs = this.clock();
  }

  /** Record what the agent just produced; a change counts as activity. */
  observe(fingerprint: string): void {
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.lastActivityAtMs = this.clock();
    }
  }

  /** How long the agent has been silent, in milliseconds. */
  idleMs(): number {
    return this.clock() - this.lastActivityAtMs;
  }

  /**
   * When the agent last did something, as an ISO timestamp.
   *
   * A silent agent is a fact an operator needs the time of: "the agent said
   * nothing after 14:32" locates the failure in the run.
   */
  lastActivityAt(): string | undefined {
    return new Date(this.lastActivityAtMs).toISOString();
  }
}
