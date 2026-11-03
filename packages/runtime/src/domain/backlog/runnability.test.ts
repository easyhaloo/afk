import { describe, expect, it } from 'vitest';
import { describeRunnability, evaluateRunnability, type RunnabilitySubject } from './runnability.js';

function subject(overrides: Partial<RunnabilitySubject> = {}): RunnabilitySubject {
  return {
    container: false,
    state: 'ready',
    executionMode: 'afk',
    executionEligible: true,
    hasChildren: false,
    dependencies: [],
    ...overrides,
  };
}

describe('evaluateRunnability', () => {
  it('accepts a ready item AFK runs with no dependency', () => {
    expect(evaluateRunnability(subject())).toEqual({ runnable: true, blockedBy: [] });
  });

  it('accepts a rework item, because rework is a runnable state too', () => {
    expect(evaluateRunnability(subject({ state: 'rework' })).runnable).toBe(true);
  });

  it('refuses a container item before anything else', () => {
    const result = evaluateRunnability(subject({ container: true, state: 'ready', executionMode: 'hitl' }));
    expect(result).toEqual({ runnable: false, reason: 'not_execution_eligible', blockedBy: [] });
  });

  it('reports a blocked item as waiting for a person', () => {
    expect(evaluateRunnability(subject({ state: 'blocked', executionMode: 'hitl' })).reason)
      .toBe('blocked_for_human');
  });

  it('reports an item AFK is working on as such, not as not executable', () => {
    // The eligibility flag is derived from the state, so an item that is
    // running carries it as false. Reporting that as "not executable" would
    // hide the fact that AFK is already on it.
    expect(evaluateRunnability(subject({ state: 'in_progress', executionEligible: false })).reason)
      .toBe('execution_in_progress');
    expect(evaluateRunnability(subject({ state: 'verification', executionEligible: false })).reason)
      .toBe('execution_in_progress');
  });

  it('reports an item that passed QA as waiting to be merged', () => {
    expect(evaluateRunnability(subject({ state: 'merge_ready' })).reason).toBe('awaiting_merge');
  });

  it('refuses a state AFK does not start work from', () => {
    expect(evaluateRunnability(subject({ state: 'done' })).reason).toBe('state_not_runnable');
  });

  it('refuses an item without a lifecycle position', () => {
    expect(evaluateRunnability(subject({ state: undefined })).reason).toBe('state_not_runnable');
  });

  it('refuses a human-run item and says so', () => {
    expect(evaluateRunnability(subject({ executionMode: 'hitl' })).reason).toBe('execution_mode_hitl');
  });

  it('refuses an item AFK does not manage', () => {
    expect(evaluateRunnability(subject({ executionEligible: false })).reason).toBe('not_managed');
  });

  it('refuses an item that owns children', () => {
    expect(evaluateRunnability(subject({ hasChildren: true })).reason).toBe('has_children');
  });

  it('names the dependencies that have not finished', () => {
    const result = evaluateRunnability(subject({
      dependencies: [
        { id: 'gitlab:host/group/repo#1', state: 'done' },
        { id: 'gitlab:host/group/repo#2', state: 'blocked' },
        { id: 'gitlab:host/group/repo#3' },
      ],
    }));
    expect(result).toEqual({
      runnable: false,
      reason: 'dependency_not_done',
      blockedBy: ['gitlab:host/group/repo#2', 'gitlab:host/group/repo#3'],
    });
  });

  it('reports the blocking rule before the execution mode', () => {
    // "blocked" is the fact an operator acts on, so it wins over who runs it.
    expect(evaluateRunnability(subject({ state: 'blocked', executionMode: 'afk' })).reason)
      .toBe('blocked_for_human');
  });

  it('reports the lifecycle position before the management flag', () => {
    expect(evaluateRunnability(subject({ state: 'in_progress', executionEligible: false, executionMode: 'hitl' })).reason)
      .toBe('execution_in_progress');
  });
});

describe('describeRunnability', () => {
  it('describes a runnable item', () => {
    expect(describeRunnability({ runnable: true, blockedBy: [] })).toBe('runnable');
  });

  it('names a single dependency', () => {
    expect(describeRunnability({ runnable: false, reason: 'dependency_not_done', blockedBy: ['a#1'] }))
      .toBe('waiting for a#1');
  });

  it('names every dependency when there are several', () => {
    expect(describeRunnability({ runnable: false, reason: 'dependency_not_done', blockedBy: ['a#1', 'b#2'] }))
      .toBe('waiting for a#1, b#2');
  });

  it('describes the remaining reasons', () => {
    expect(describeRunnability({ runnable: false, reason: 'execution_mode_hitl', blockedBy: [] }))
      .toBe('run by a human, not by AFK');
    expect(describeRunnability({ runnable: false, reason: 'has_children', blockedBy: [] }))
      .toBe('owns children; the children are the work');
    expect(describeRunnability({ runnable: false, reason: 'state_not_runnable', blockedBy: [] }))
      .toBe('not in a startable state');
    expect(describeRunnability({ runnable: false, reason: 'not_execution_eligible', blockedBy: [] }))
      .toBe('not executable (container item)');
    expect(describeRunnability({ runnable: false, reason: 'blocked_for_human', blockedBy: [] }))
      .toBe('blocked — waiting for a person');
    expect(describeRunnability({ runnable: false, reason: 'execution_in_progress', blockedBy: [] }))
      .toBe('AFK is working on it');
    expect(describeRunnability({ runnable: false, reason: 'awaiting_merge', blockedBy: [] }))
      .toBe('passed QA — waiting to be merged');
    expect(describeRunnability({ runnable: false, reason: 'not_managed', blockedBy: [] }))
      .toBe('not managed by AFK');
  });
});
