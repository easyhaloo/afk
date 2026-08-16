import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexAppServerExecution } from '../../src/lib/agents/codex-app-server/execution';
import { createStdioAppServerTransport } from '../../src/lib/agents/codex-app-server/transport';
import type { AgentExecutionOptions, CodexRuntimeSelection } from '../../src/lib/agents/types';

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url));
const runtime: CodexRuntimeSelection = {
  kind: 'codex', transport: 'app-server', auth: 'unknown', provider: 'auto',
  endpoint: 'stdio://', startupTimeoutMs: 2_000,
};

function options(prompt = 'complete the fixture'): AgentExecutionOptions {
  return {
    sandbox: { id: 'local', worktreePath: process.cwd(), workspacePath: process.cwd() } as never,
    worktreePath: process.cwd(), sessionId: 'fixture-session', prompt,
    signalType: 'goal_complete', generation: 1, executionMode: 'batch', runtime,
  };
}

function fixtureTransport() {
  return createStdioAppServerTransport(process.execPath, [fixture]);
}

async function expectProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`fixture process ${pid} did not exit`);
}

describe('Codex app-server stdio integration', () => {
  it('runs the real JSONL transport through completion and cleans up the process', async () => {
    const execution = await CodexAppServerExecution.start(options(), runtime, fixtureTransport);
    const result = await execution.waitForResult({ completionTimeoutMs: 2_000 });
    const pid = Number(execution.metadata.threadId?.split('-').at(-1));

    expect(result).toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', summary: 'app server fixture complete' },
      usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
    });
    expect(execution.metadata).toMatchObject({ transport: 'app-server', endpointKind: 'stdio' });
    await expectProcessExit(pid);
  });

  it('interrupts an active fixture turn and cleans up the process', async () => {
    const execution = await CodexAppServerExecution.start(options('AFK_FIXTURE_HOLD'), runtime, fixtureTransport);
    const pid = Number(execution.metadata.threadId?.split('-').at(-1));
    await execution.interrupt('manual');

    await expect(execution.waitForResult()).resolves.toMatchObject({ status: 'aborted' });
    await expectProcessExit(pid);
  });
});
