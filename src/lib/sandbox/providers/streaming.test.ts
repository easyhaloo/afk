import { describe, expect, it } from 'vitest';
import { StreamingAgentExecution } from './streaming';
import { CodexProvider } from '../../agents/codex';

function command(script: string) {
  return { argv: [process.execPath, '-e', script], cwd: process.cwd() };
}

const PROCESS_METADATA = { provider: 'claude-code', transport: 'process' } as const;

describe('StreamingAgentExecution', () => {
  it('completes from Codex JSONL and preserves normalized token usage', async () => {
    const usage = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 5 },
    });
    const result = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"codex fixture complete"}</goal_complete>',
      },
    });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(usage)}); console.log(${JSON.stringify(result)})`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
      parseLine: new CodexProvider().parseLine.bind(new CodexProvider()),
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'codex fixture complete' },
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(execution.metadata).toEqual({ provider: 'codex', transport: 'exec' });
  });

  it('buffers JSONL records split across stdout chunks', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`process.stdout.write(${JSON.stringify(payload.slice(0, 20))}); setTimeout(() => process.stdout.write(${JSON.stringify(payload.slice(20) + '\n')}), 5)`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    await expect(execution.waitForResult({ completionTimeoutMs: 1000 })).resolves.toMatchObject({ status: 'completed' });
  });

  it('accepts a completion marker whose payload omits the redundant type field', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"summary":"done"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', summary: 'done' },
    });
  });

  it('extracts a completion marker after ordinary result text', async () => {
    const result = [
      'Implemented and verified the requested change.',
      '',
      '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>',
    ].join('\n');
    const payload = JSON.stringify({ type: 'result', result });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'done' },
    });
  });

  it('completes when a valid marker arrives before the child exits', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(payload)}); setInterval(() => {}, 1_000)`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete' },
    });
  });

  it('completes from a marker in an unterminated stdout record', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({
      command: command(`process.stdout.write(${JSON.stringify(payload)}); setInterval(() => {}, 10_000)`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete' },
    });
  });

  it('fails when the child exits non-zero even after emitting a result', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)}); process.exit(3)`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    await expect(execution.waitForResult({ completionTimeoutMs: 1000 })).resolves.toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('includes the final stdout tail when a child exits without stderr', async () => {
    const payload = JSON.stringify({ type: 'assistant', message: 'provider failure: invalid request' });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(payload)}); process.exit(1)`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1000 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'NON_ZERO_EXIT', message: expect.stringContaining('provider failure') },
    });
  });

  it('includes the final agent result when it exits successfully without a completion marker', async () => {
    const payload = JSON.stringify({ type: 'result', result: 'implemented the changes but forgot the AFK marker' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1000 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'MISSING_RESULT', message: expect.stringContaining('implemented the changes but forgot the AFK marker') },
    });
  });

  it('captures batch stdout for runtime diagnostics', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1000 })).resolves.toMatchObject({ status: 'completed' });
    await expect(execution.captureOutput()).resolves.toContain('goal_complete');
  });

  it('kills the full batch process group, including child agent processes', async () => {
    const execution = new StreamingAgentExecution({
      command: command("const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' }); console.log(child.pid); setInterval(() => {}, 10000);"),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();
    const childPid = await new Promise<number>((resolve, reject) => {
      const deadline = Date.now() + 1_000;
      const poll = async () => {
        const pid = Number((await execution.captureOutput()).trim());
        if (pid > 0) return resolve(pid);
        if (Date.now() >= deadline) return reject(new Error('child PID was not captured'));
        setTimeout(poll, 10);
      };
      void poll();
    });
    expect(childPid).toBeGreaterThan(0);

    await execution.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      process.kill(childPid, 0);
      throw new Error(`child process ${childPid} is still alive`);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
  });

  it('kills descendants that create their own process groups after completion', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({
      command: command(`const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { detached: true, stdio: 'ignore' }); console.log(child.pid); console.log(${JSON.stringify(payload)}); setInterval(() => {}, 10000);`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child PID was not captured')), 1_000);
      const poll = async () => {
        const pid = Number((await execution.captureOutput()).split('\n')[0]);
        if (pid > 0) {
          clearTimeout(timer);
          resolve(pid);
          return;
        }
        setTimeout(poll, 10);
      };
      void poll();
    });

    await expect(execution.waitForResult({ completionTimeoutMs: 1_000 })).resolves.toMatchObject({ status: 'completed' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});
