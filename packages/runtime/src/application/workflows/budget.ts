export class BudgetManager {
  /** @internal — public for test injection; do not mutate directly in production. */
  used: number = 0;
  /** @internal — public for test injection; do not mutate directly in production. */
  tokens: number = 0;
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly maxHandoffs: number,
    private readonly maxTotalTokens: number,
  ) {}

  /**
   * True when another handoff round is still allowed under the max-handoffs
   * and max-total-tokens limits.
   *
   * NOTE: callers that need to check token headroom separately (for the
   * "terminal tokens" path) should use isExhausted(freshTokens) instead.
   */
  canHandoff(): boolean {
    return this.used < this.maxHandoffs && this.tokens < this.maxTotalTokens;
  }

  /**
   * True when no further rounds are possible under either limit.
   * Use `isExhausted(incomingTokens)` to check whether a pending token
   * count would push the session into terminal state.
   */
  isExhausted(incomingTokens = 0): boolean {
    return (
      this.used >= this.maxHandoffs ||
      this.tokens + incomingTokens >= this.maxTotalTokens
    );
  }

  /**
   * Which limit was hit when exhausted, or null if not exhausted.
   * Use this to determine the terminal reason after isExhausted returns true.
   */
  exhaustionReason(incomingTokens = 0): 'budget' | 'tokens' | null {
    if (this.used >= this.maxHandoffs) return 'budget';
    if (this.tokens + incomingTokens >= this.maxTotalTokens) return 'tokens';
    return null;
  }

  recordHandoff(): void {
    this.used++;
  }

  recordSession(sessionId: string, tokens: number): boolean {
    if (!sessionId || !Number.isSafeInteger(tokens) || tokens < 0) throw new Error('invalid session token usage');
    const previous = this.sessions.get(sessionId) ?? 0;
    if (this.sessions.has(sessionId) && tokens <= previous) return false;
    this.sessions.set(sessionId, tokens);
    this.tokens += tokens - previous;
    return true;
  }

  snapshot(): { used: number; tokens: number; sessions: Record<string, number> } {
    return { used: this.used, tokens: this.tokens, sessions: Object.fromEntries(this.sessions) };
  }

  static fromSnapshot(
    snapshot: { used: number; tokens: number; sessions: Record<string, number> },
    maxHandoffs: number,
    maxTotalTokens: number,
  ): BudgetManager {
    const manager = new BudgetManager(maxHandoffs, maxTotalTokens);
    manager.used = snapshot.used;
    manager.tokens = snapshot.tokens;
    for (const [sessionId, tokens] of Object.entries(snapshot.sessions)) manager.sessions.set(sessionId, tokens);
    return manager;
  }

  /**
   * Test-only factory: creates a BudgetManager with arbitrary internal state.
   * Do NOT use in production code.
   */
  static forTest(used: number, tokens: number, maxHandoffs: number, maxTotalTokens: number): BudgetManager {
    const m = new BudgetManager(maxHandoffs, maxTotalTokens);
    m.used = used;
    m.tokens = tokens;
    return m;
  }
}
