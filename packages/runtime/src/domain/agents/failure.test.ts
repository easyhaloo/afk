import { describe, expect, it } from 'vitest';
import { isRetryableAgentFailure, RETRYABLE_AGENT_ERROR_CODES } from './failure.js';

describe('retryable agent failures', () => {
  it('repeats an attempt when the agent died rather than failed the work', () => {
    expect(isRetryableAgentFailure({ status: 'failed', error: { code: 'AGENT_TURN_FAILED' } })).toBe(true);
    expect(isRetryableAgentFailure({ status: 'failed', error: { code: 'AGENT_GONE' } })).toBe(true);
    expect(isRetryableAgentFailure({ status: 'failed', error: { code: 'AGENT_IDLE' } })).toBe(true);
  });

  it('does not repeat an attempt that says something about the work', () => {
    expect(isRetryableAgentFailure({ status: 'failed', error: { code: 'SIGNAL_MISMATCH' } })).toBe(false);
    expect(isRetryableAgentFailure({ status: 'failed', error: { code: 'AGENT_ERROR' } })).toBe(false);
    expect(isRetryableAgentFailure({ status: 'failed' })).toBe(false);
    expect(isRetryableAgentFailure({ status: 'timed_out' })).toBe(false);
    expect(isRetryableAgentFailure({ status: 'completed' })).toBe(false);
  });

  it('names the codes it repeats on', () => {
    expect([...RETRYABLE_AGENT_ERROR_CODES].sort()).toEqual(['AGENT_GONE', 'AGENT_IDLE', 'AGENT_TURN_FAILED']);
  });
});
