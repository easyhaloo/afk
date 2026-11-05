import { describe, expect, it } from 'vitest';
import { formatExecutionFailure, formatExecutionFailureReport } from '../workflow-engine.js';

describe('execution diagnostics', () => {
  it('keeps the provider details out of the cause and in the evidence', () => {
    const report = formatExecutionFailureReport({
      version: 1,
      runId: 'run-1',
      status: 'failed',
      provider: 'batch',
      exitCode: 3,
      error: { code: 'NON_ZERO_EXIT', message: 'agent stderr' },
      structuredOutput: { type: 'agent_error', detail: 'bad request' },
      commits: [],
    });

    // The cause names the failure; it is not a pile of provider fields.
    expect(formatExecutionFailure({
      version: 1,
      runId: 'run-1',
      status: 'failed',
      provider: 'batch',
      exitCode: 3,
      error: { code: 'NON_ZERO_EXIT', message: 'agent stderr' },
      structuredOutput: { type: 'agent_error', detail: 'bad request' },
      commits: [],
    })).toBe('the agent process failed with exit code 3');

    // The structured output survives as evidence.
    expect(report).toContain('provider structured output');
    expect(report).toContain('"detail":"bad request"');
    expect(report).toContain('agent process exit code');
  });

  it('reports the agent own report as the cause when there is one', () => {
    const message = formatExecutionFailure({
      version: 1,
      runId: 'run-1',
      status: 'failed',
      provider: 'batch',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'the repository has no remote configured' },
      commits: [],
    });

    expect(message).toBe('the repository has no remote configured');
  });
});
