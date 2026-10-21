import { describe, expect, it } from 'vitest';
import { GOAL_COMPLETE_RESULTS, SIGNAL_TYPES } from '../src/workflow-signal.js';

describe('the signal vocabulary', () => {
  it('names the results a QA signal can carry', () => {
    expect([...GOAL_COMPLETE_RESULTS]).toEqual(['PASS', 'FAIL']);
  });

  it('names the signals a run may leave behind', () => {
    expect([...SIGNAL_TYPES]).toEqual(['goal_complete', 'handoff_ready', 'timeout', 'idle']);
  });
});
