import { describe, expect, it } from 'vitest';
import { GoalCompleteSignalSchema, SignalSchema } from './schemas.js';

describe('signal timestamps', () => {
  it('accepts the Z form written by JavaScript agents', () => {
    const result = GoalCompleteSignalSchema.safeParse({
      type: 'goal_complete',
      timestamp: '2026-10-29T14:50:41.297316Z',
      summary: 'done',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the offset form written by Python agents', () => {
    const result = GoalCompleteSignalSchema.safeParse({
      type: 'goal_complete',
      timestamp: '2026-10-29T14:50:41.297316+00:00',
      summary: 'done',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a non-UTC offset', () => {
    const result = GoalCompleteSignalSchema.safeParse({
      type: 'goal_complete',
      timestamp: '2026-10-29T22:50:41+08:00',
      summary: 'done',
    });
    expect(result.success).toBe(true);
  });

  it('still rejects a timestamp that is not ISO-8601', () => {
    const result = GoalCompleteSignalSchema.safeParse({
      type: 'goal_complete',
      timestamp: '2026-10-29 14:50:41',
      summary: 'done',
    });
    expect(result.success).toBe(false);
  });

  it('parses an agent-written signal through the union schema', () => {
    const result = SignalSchema.safeParse({
      type: 'goal_complete',
      timestamp: '2026-10-29T14:50:41.297316+00:00',
      kind: 'task',
      summary: 'FAIL: pytest cannot collect because Django is not installed.',
    });
    expect(result.success).toBe(true);
  });
});
