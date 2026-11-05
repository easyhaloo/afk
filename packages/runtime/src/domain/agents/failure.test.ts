import { describe, expect, it } from 'vitest';
import { classifyAgentFailure, isRetryableAgentFailure, RETRYABLE_AGENT_ERROR_CODES } from './failure.js';

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

describe('agent failure classification', () => {
  it('reads a provider error as an upstream fact', () => {
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'AGENT_ERROR' } }).kind).toBe('upstream');
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'AGENT_TURN_FAILED' } }).kind).toBe('upstream');
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'TRANSPORT_CLOSED' } }).kind).toBe('upstream');
  });

  it('reads a silent or vanished agent as an agent-run fact', () => {
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'AGENT_IDLE' } }).kind).toBe('agent_run');
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'AGENT_GONE' } }).kind).toBe('agent_run');
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'MISSING_RESULT' } }).kind).toBe('agent_run');
  });

  it('knows that a non-zero exit carries process output rather than a reason', () => {
    const classification = classifyAgentFailure({ status: 'failed', error: { code: 'NON_ZERO_EXIT' } });
    expect(classification.kind).toBe('process_output');
    expect(classification.messageIsProviderOutput).toBe(true);
  });

  it('treats a code it does not know as an agent-run fact', () => {
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'SOMETHING_NEW' } }).kind).toBe('agent_run');
    expect(classifyAgentFailure({ status: 'failed' }).kind).toBe('agent_run');
  });

  it('repeats only the codes the vocabulary names', () => {
    expect(classifyAgentFailure({ status: 'failed', error: { code: 'AGENT_IDLE' } }).retryable).toBe(true);
    expect(classifyAgentFailure({ status: 'timed_out', error: { code: 'AGENT_IDLE' } }).retryable).toBe(false);
  });
});
