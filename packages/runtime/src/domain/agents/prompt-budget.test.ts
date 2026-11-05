import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOAL_CONDITION_MAX_CHARS,
  goalConditionText,
  measurePromptBudget,
  PromptBudgetExceededError,
  resolveGoalConditionLimit,
  usesGoalChannel,
} from './prompt-budget.js';

describe('goal channel detection', () => {
  it('reads the goal condition as the text after the /goal command', () => {
    expect(goalConditionText('/goal verify the acceptance criteria')).toBe('verify the acceptance criteria');
    expect(goalConditionText('  /goal   verify the acceptance criteria')).toBe('verify the acceptance criteria');
    expect(goalConditionText('/GOAL verify')).toBe('verify');
  });

  it('does not treat an ordinary message as a goal condition', () => {
    expect(goalConditionText('AFK batch goal:\nverify the acceptance criteria')).toBeUndefined();
    expect(goalConditionText('the goal is to verify the criteria')).toBeUndefined();
    expect(usesGoalChannel('/goal verify')).toBe(true);
    expect(usesGoalChannel('AFK batch goal:\nverify')).toBe(false);
  });
});

describe('goal condition limit', () => {
  it('uses the limit the provider declares', () => {
    expect(resolveGoalConditionLimit({ goalConditionMaxChars: 1234 })).toBe(1234);
  });

  it('falls back to the strictest known limit for a provider that declares none', () => {
    expect(resolveGoalConditionLimit(undefined)).toBe(DEFAULT_GOAL_CONDITION_MAX_CHARS);
    expect(resolveGoalConditionLimit({})).toBe(DEFAULT_GOAL_CONDITION_MAX_CHARS);
    expect(resolveGoalConditionLimit({ goalConditionMaxChars: 0 })).toBe(DEFAULT_GOAL_CONDITION_MAX_CHARS);
    expect(resolveGoalConditionLimit({ goalConditionMaxChars: -1 })).toBe(DEFAULT_GOAL_CONDITION_MAX_CHARS);
    expect(resolveGoalConditionLimit({ goalConditionMaxChars: Number.NaN })).toBe(DEFAULT_GOAL_CONDITION_MAX_CHARS);
  });
});

describe('prompt budget', () => {
  it('measures the goal condition, not the whole prompt', () => {
    const budget = measurePromptBudget({ prompt: '/goal do the work' });

    expect(budget.applies).toBe(true);
    expect(budget.limit).toBe(DEFAULT_GOAL_CONDITION_MAX_CHARS);
    expect(budget.actual).toBe('do the work'.length);
    expect(budget.exceeded).toBe(false);
    expect(budget.overBy).toBe(0);
  });

  it('does not apply a limit to a prompt that is not a goal command', () => {
    const budget = measurePromptBudget({ prompt: 'AFK batch goal:\ndo the work' });

    expect(budget.applies).toBe(false);
    expect(budget.limit).toBeUndefined();
    expect(budget.exceeded).toBe(false);
    expect(budget.actual).toBe('AFK batch goal:\ndo the work'.length);
  });

  it('reports the length, the limit and the part that crossed it', () => {
    const budget = measurePromptBudget({
      prompt: `/goal ${'x'.repeat(500)}`,
      parts: [
        { label: 'goal task statement', text: 'x'.repeat(100) },
        { label: 'backlog context pointer', text: 'y'.repeat(400) },
      ],
      limits: { goalConditionMaxChars: 200 },
    });

    expect(budget.exceeded).toBe(true);
    expect(budget.actual).toBe(500);
    expect(budget.limit).toBe(200);
    expect(budget.overBy).toBe(300);
    expect(budget.exceededByPart).toBe('backlog context pointer');
    expect(budget.parts).toEqual([
      { label: 'goal task statement', chars: 100 },
      { label: 'backlog context pointer', chars: 400 },
    ]);
  });

  it('accepts a goal that is exactly at the limit', () => {
    const budget = measurePromptBudget({
      prompt: `/goal ${'x'.repeat(100)}`,
      limits: { goalConditionMaxChars: 100 },
    });

    expect(budget.exceeded).toBe(false);
    expect(budget.overBy).toBe(0);
  });

  it('carries the measurement in the error it raises', () => {
    const budget = measurePromptBudget({
      prompt: `/goal ${'x'.repeat(10)}`,
      parts: [{ label: 'goal task statement', text: 'x'.repeat(10) }],
      limits: { goalConditionMaxChars: 5 },
    });

    const error = new PromptBudgetExceededError(budget);

    expect(error.budget).toBe(budget);
    expect(error.message).toContain('10 characters');
    expect(error.message).toContain('5-character');
    expect(error.message).toContain('goal task statement');
  });
});
