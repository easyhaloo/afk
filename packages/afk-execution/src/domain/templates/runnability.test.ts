import { describe, expect, it } from 'vitest';
import { clauseMatches, isStepRunnable, selectRunnable } from './runnability.js';
import type { StepResult } from './types.js';

const OUTCOMES = ['completed', 'failed', 'aborted', 'timed_out'] as const;
type Outcome = typeof OUTCOMES[number];

function result(stepId: string, status: Outcome): StepResult {
  return { stepId, status, startedAt: 'now', completedAt: 'now' };
}

describe('runnability rule', () => {
  describe('the condition gate', () => {
    it('runs a step without a clause', () => {
      expect(isStepRunnable({ id: 'x' }, {})).toBe(true);
    });

    it('is never satisfied by a step that never ran', () => {
      for (const equals of OUTCOMES) {
        expect(isStepRunnable({ id: 'x', when: { step: 'w', equals } }, {})).toBe(false);
      }
      expect(isStepRunnable({ id: 'x', when: { step: 'w', notEquals: 'failed' } }, {})).toBe(false);
    });

    it.each(OUTCOMES)('matches an equals clause against a recorded %s outcome', status => {
      for (const equals of OUTCOMES) {
        const results = { w: result('w', status) };
        expect(isStepRunnable({ id: 'x', when: { step: 'w', equals } }, results)).toBe(status === equals);
      }
    });

    it.each(OUTCOMES)('matches a notEquals clause against a recorded %s outcome', status => {
      for (const notEquals of OUTCOMES) {
        const results = { w: result('w', status) };
        expect(isStepRunnable({ id: 'x', when: { step: 'w', notEquals } }, results)).toBe(status !== notEquals);
      }
    });

    it('exposes the clause match on its own', () => {
      expect(clauseMatches({ step: 'w', equals: 'completed' }, 'completed')).toBe(true);
      expect(clauseMatches({ step: 'w', equals: 'completed' }, 'failed')).toBe(false);
      expect(clauseMatches({ step: 'w', notEquals: 'failed' }, 'aborted')).toBe(true);
    });
  });

  describe('the dependency gate', () => {
    it('requires a dependency to have run', () => {
      expect(isStepRunnable({ id: 'x', dependsOn: ['d'] }, {})).toBe(false);
    });

    it('requires a dependency to have completed', () => {
      for (const status of OUTCOMES) {
        const results = { d: result('d', status) };
        expect(isStepRunnable({ id: 'x', dependsOn: ['d'] }, results)).toBe(status === 'completed');
      }
    });

    it('lets a step recover from a dependency it names in its own clause', () => {
      const results = { d: result('d', 'failed') };
      expect(isStepRunnable({ id: 'x', dependsOn: ['d'], when: { step: 'd', equals: 'failed' } }, results)).toBe(true);
      expect(isStepRunnable({ id: 'x', dependsOn: ['d'], when: { step: 'd', equals: 'completed' } }, results)).toBe(false);
    });

    it('does not let a clause about another step waive a failed dependency', () => {
      const results = { d: result('d', 'failed'), w: result('w', 'completed') };
      expect(isStepRunnable({ id: 'x', dependsOn: ['d'], when: { step: 'w', equals: 'completed' } }, results)).toBe(false);
    });

    it('does not let a satisfied clause waive a dependency that never ran', () => {
      const results = { w: result('w', 'completed') };
      expect(isStepRunnable({ id: 'x', dependsOn: ['d'], when: { step: 'w', equals: 'completed' } }, results)).toBe(false);
    });
  });

  describe('selecting a runnable group', () => {
    it('keeps declaration order and drops the steps that cannot run', () => {
      const results = { a: result('a', 'completed'), b: result('b', 'failed') };
      const steps = [
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: [] },
        { id: 'c', dependsOn: ['b'] },
        { id: 'd', dependsOn: ['b'], when: { step: 'b', equals: 'failed' } },
        { id: 'e', dependsOn: ['ghost'] },
      ];
      expect(selectRunnable(steps, results).map(s => s.id)).toEqual(['a', 'b', 'd']);
    });
  });
});
