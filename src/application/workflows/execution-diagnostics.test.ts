import { describe, expect, it } from 'vitest';
import { formatExecutionFailure } from '../workflow-engine';

describe('execution diagnostics', () => {
  it('includes the execution status and provider details in failure messages', () => {
    const message = formatExecutionFailure({
      version: 1,
      runId: 'run-1',
      status: 'failed',
      provider: 'batch',
      exitCode: 3,
      error: { code: 'NON_ZERO_EXIT', message: 'agent stderr' },
      structuredOutput: { type: 'agent_error', detail: 'bad request' },
      commits: [],
    });

    expect(message).toContain('status=failed');
    expect(message).toContain('provider=batch');
    expect(message).toContain('exitCode=3');
    expect(message).toContain('NON_ZERO_EXIT: agent stderr');
    expect(message).toContain('structuredOutput={"type":"agent_error","detail":"bad request"}');
  });
});
