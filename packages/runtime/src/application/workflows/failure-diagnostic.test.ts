import { describe, expect, it } from 'vitest';
import {
  appendFailure,
  createFailureDiagnostic,
  diagnoseExecutionFailure,
  diagnoseStepFailure,
  extractFailureLines,
  failureClassOf,
  renderFailureReport,
  renderFailureSummary,
  rootCause,
  snapshotFailure,
  truncateOutputTail,
  type FailureDiagnostic,
} from './failure-diagnostic.js';

function result(overrides: Partial<Parameters<typeof diagnoseExecutionFailure>[0]>): Parameters<typeof diagnoseExecutionFailure>[0] {
  return {
    version: 1,
    runId: 'run-1',
    status: 'failed',
    provider: 'batch',
    commits: [],
    ...overrides,
  };
}

describe('structured failure diagnostics', () => {
  it('separates a verdict about the work from the facts around it', () => {
    const failure = diagnoseStepFailure({
      stepId: 'verify-ac',
      status: 'failed',
      summary: 'the shortcut does not hold',
      output: {
        type: 'goal_complete',
        kind: 'ac_verification',
        result: 'FAIL',
        summary: 'the shortcut does not hold',
        failedCriteria: [{ id: 'ac-1', expected: 'a shortcut to the list', actual: 'the list renders in full' }],
      },
    });

    expect(failure.code).toBe('acceptance_criteria_failed');
    expect(failure.class).toBe('work');
    expect(failure.message).toBe('the shortcut does not hold');
    expect(failure.evidence).toContainEqual(expect.objectContaining({
      label: 'criterion ac-1',
      expected: 'a shortcut to the list',
      actual: 'the list renders in full',
    }));
  });

  it('reads a silent agent as an agent-run fact, with the budget that ran out', () => {
    const failure = diagnoseExecutionFailure(result({
      status: 'timed_out',
      error: { code: 'AGENT_IDLE', message: 'the agent produced no output for 1800s' },
      diagnostics: {
        timeout: {
          kind: 'idle',
          budgetMs: 1_800_000,
          idleMs: 1_800_000,
          lastActivityAt: '2026-11-05T09:12:00.000Z',
        },
      },
    }));

    expect(failure.code).toBe('agent_idle_timeout');
    expect(failure.class).toBe('agent');
    expect(failure.providerCode).toBe('AGENT_IDLE');
    expect(failure.message).toContain('1800000ms');
    expect(failure.evidence).toContainEqual(expect.objectContaining({
      kind: 'timeout',
      label: 'timeout budget',
      expected: '1800000ms',
    }));
    expect(failure.evidence).toContainEqual(expect.objectContaining({
      kind: 'activity',
      label: 'last known activity',
      actual: '2026-11-05T09:12:00.000Z',
    }));
  });

  it('reads an overloaded model service as an upstream fact, not as a verdict on the work', () => {
    const failure = diagnoseExecutionFailure(result({
      error: { code: 'AGENT_ERROR', message: 'Stream disconnected before completion: Our servers are currently overloaded.' },
    }));

    expect(failure.code).toBe('upstream_model_error');
    expect(failure.class).toBe('upstream');
    expect(failure.providerCode).toBe('AGENT_ERROR');
    expect(failure.message).toContain('overloaded');
    expect(failure.retryable).toBe(false);
  });

  it('keeps provider output out of the cause and lifts the error lines out of it', () => {
    const output = [
      '> afk@0.1.0 lint',
      '> pre-commit hook: lint-staged',
      'src/store/user.ts(42,17): error TS2339: Property \'isAdmin\' does not exist on type \'User\'.',
      'src/store/user.ts(43,9): error TS2339: Property \'isAdmin\' does not exist on type \'User\'.',
    ].join('\n');

    const failure = diagnoseExecutionFailure(result({
      status: 'failed',
      exitCode: 1,
      error: { code: 'NON_ZERO_EXIT', message: output },
    }));

    // The cause names the real reason, not the tail of the process log.
    expect(failure.code).toBe('agent_process_failed');
    expect(failure.class).toBe('agent');
    expect(failure.message).toContain("error TS2339: Property 'isAdmin' does not exist");
    expect(failure.message).not.toContain('lint-staged');
    // The whole captured output stays available as evidence.
    const captured = failure.evidence.find(evidence => evidence.label.startsWith('agent output'));
    expect(captured?.detail).toContain('lint-staged');
    expect(failure.evidence.some(evidence => evidence.label === 'agent reported errors')).toBe(true);
  });

  it('reads whether repeating the attempt is meaningful from the diagnosis', () => {
    expect(diagnoseExecutionFailure(result({
      error: { code: 'AGENT_GONE', message: 'the agent session ended before it reported completion' },
    })).retryable).toBe(true);
    expect(diagnoseExecutionFailure(result({
      error: { code: 'AGENT_TURN_FAILED', message: 'the turn stream was cut' },
    })).retryable).toBe(true);
    expect(diagnoseExecutionFailure(result({
      error: { code: 'SIGNAL_MISMATCH', message: 'the completion signal did not match' },
    })).retryable).toBe(false);
  });

  it('keeps the first failure as the root cause and appends the later ones', () => {
    const first = createFailureDiagnostic({ code: 'agent_idle_timeout', message: 'the agent went silent' });
    const second = createFailureDiagnostic({ code: 'workflow_crash', message: 'workflow crashed: the step threw' });

    const chain = appendFailure(appendFailure([], first), second);

    expect(rootCause(chain)?.message).toBe('the agent went silent');
    expect(chain).toHaveLength(2);
    expect(chain[1].cause?.message).toBe('the agent went silent');
    expect(renderFailureSummary(chain)).toBe('the agent went silent');
    expect(renderFailureReport(chain)).toContain('Aftermath:');
    expect(renderFailureReport(chain)).toContain('workflow_crash: workflow crashed: the step threw');
  });

  it('cuts a long captured output to its tail and says that it did', () => {
    const output = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    const tail = truncateOutputTail(output);

    expect(tail.truncated).toBe(true);
    expect(tail.detail.split('\n')).toHaveLength(40);
    expect(tail.detail).toContain('line 199');
    expect(tail.detail).not.toContain('line 0\n');
  });

  it('finds the error lines in captured output', () => {
    const lines = extractFailureLines([
      'building the project',
      'src/a.ts(1,1): error TS2339: Property \'x\' does not exist',
      'building the project',
      '✖ 3 problems',
    ].join('\n'));

    expect(lines).toContain("src/a.ts(1,1): error TS2339: Property 'x' does not exist");
    expect(lines).toContain('✖ 3 problems');
    expect(lines).not.toContain('building the project');
  });

  it('snapshots the cause chain into a bounded shape', () => {
    let chain: FailureDiagnostic[] = [];
    for (const message of ['first', 'second', 'third']) {
      chain = appendFailure(chain, createFailureDiagnostic({ code: 'workflow_crash', message }));
    }
    const snapshot = snapshotFailure(chain[2], 1);

    expect(snapshot?.message).toBe('third');
    expect(snapshot?.cause?.message).toBe('second');
    expect(snapshot?.cause?.cause).toBeUndefined();
  });

  it('classifies every failure code it can produce', () => {
    expect(failureClassOf('acceptance_criteria_failed')).toBe('work');
    expect(failureClassOf('agent_idle_timeout')).toBe('agent');
    expect(failureClassOf('upstream_model_error')).toBe('upstream');
    expect(failureClassOf('qa_environment_missing')).toBe('environment');
    expect(failureClassOf('workflow_crash')).toBe('infrastructure');
  });
});
