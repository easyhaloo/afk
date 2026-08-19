/**
 * BudgetManager — encapsulates handoff budget state and mutations.
 *
 * Before: `budget: { used: number; tokens: number }` was created in runBody,
 * passed around, and mutated in-place at multiple call sites with opaque
 * comparisons like `p.budget.used >= p.maxHandoffs`.
 *
 * After: a single class holds the state and limits, exposing intentful
 * queries and a single mutation point:
 *   - canHandoff()         → readable guard instead of `used >= maxHandoffs`
 *   - isExhausted(tokens)  → readable guard instead of `tokens + usedTokens >= maxTotalTokens`
 *   - record(tokens)        → single mutation: used++ and tokens+=
 *   - used / tokens         → readonly getters for logging
 */
export class BudgetManager {
  /** @internal — public for test injection; do not mutate directly in production. */
  used: number = 0;
  /** @internal — public for test injection; do not mutate directly in production. */
  tokens: number = 0;

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
  isExhausted(incomingTokens: number): boolean {
    return (
      this.used >= this.maxHandoffs ||
      this.tokens + incomingTokens >= this.maxTotalTokens
    );
  }

  /**
   * Which limit was hit when exhausted, or null if not exhausted.
   * Use this to determine the terminal reason after isExhausted returns true.
   */
  exhaustionReason(incomingTokens: number): 'budget' | 'tokens' | null {
    if (this.used >= this.maxHandoffs) return 'budget';
    if (this.tokens + incomingTokens >= this.maxTotalTokens) return 'tokens';
    return null;
  }

  /**
   * Record one completed handoff round.
   * Idempotent — safe to call even when already exhausted.
   */
  record(tokens: number): void {
    this.used++;
    this.tokens += tokens;
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
