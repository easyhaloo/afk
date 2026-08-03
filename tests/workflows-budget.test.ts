/**
 * Unit tests for BudgetManager — the handoff budget encapsulation.
 */
import { describe, it, expect } from 'vitest';
import { BudgetManager } from '../src/lib/workflows/budget';

describe('BudgetManager', () => {
  it('starts at zero', () => {
    const b = new BudgetManager(3, 500_000);
    expect(b.used).toBe(0);
    expect(b.tokens).toBe(0);
  });

  it('canHandoff is true when within limits', () => {
    const b = new BudgetManager(3, 500_000);
    expect(b.canHandoff()).toBe(true);
  });

  it('canHandoff is false when used >= maxHandoffs', () => {
    const b = BudgetManager.forTest(3, 0, 3, 500_000);
    expect(b.canHandoff()).toBe(false);
  });

  it('canHandoff is false when tokens >= maxTotalTokens', () => {
    const b = BudgetManager.forTest(0, 500_000, 3, 500_000);
    expect(b.canHandoff()).toBe(false);
  });

  it('isExhausted returns false when both limits have headroom', () => {
    const b = new BudgetManager(3, 500_000);
    expect(b.isExhausted(0)).toBe(false);
    expect(b.isExhausted(100_000)).toBe(false);
  });

  it('isExhausted returns true when used >= maxHandoffs', () => {
    const b = BudgetManager.forTest(3, 0, 3, 500_000);
    expect(b.isExhausted(0)).toBe(true);
  });

  it('isExhausted returns true when tokens + incoming >= maxTotalTokens', () => {
    const b = BudgetManager.forTest(1, 400_000, 3, 500_000);
    expect(b.isExhausted(100_000)).toBe(true); // 400k + 100k >= 500k (equal = exhausted)
    expect(b.isExhausted(99_999)).toBe(false); // 400k + 99999 < 500k
  });

  it('exhaustionReason returns budget when used >= maxHandoffs', () => {
    const b = BudgetManager.forTest(3, 0, 3, 500_000);
    expect(b.exhaustionReason(0)).toBe('budget');
  });

  it('exhaustionReason returns tokens when tokens would be exceeded', () => {
    const b = BudgetManager.forTest(1, 400_000, 3, 500_000);
    expect(b.exhaustionReason(100_001)).toBe('tokens');
  });

  it('exhaustionReason returns null when not exhausted', () => {
    const b = new BudgetManager(3, 500_000);
    expect(b.exhaustionReason(100_000)).toBe(null);
  });

  it('record increments used and tokens', () => {
    const b = new BudgetManager(3, 500_000);
    b.record(90_000);
    expect(b.used).toBe(1);
    expect(b.tokens).toBe(90_000);
    b.record(80_000);
    expect(b.used).toBe(2);
    expect(b.tokens).toBe(170_000);
  });

  it('record is idempotent (can call even when exhausted)', () => {
    const b = BudgetManager.forTest(3, 500_000, 3, 500_000);
    b.record(0); // must not throw
    expect(b.used).toBe(4);
  });

  it('forTest creates manager with arbitrary state', () => {
    const b = BudgetManager.forTest(2, 300_000, 3, 500_000);
    expect(b.used).toBe(2);
    expect(b.tokens).toBe(300_000);
    expect(b.isExhausted(0)).toBe(false); // used(2) < maxHandoffs(3)
    expect(b.isExhausted(200_001)).toBe(true); // tokens(300k) + 200001 > 500k
  });
});
