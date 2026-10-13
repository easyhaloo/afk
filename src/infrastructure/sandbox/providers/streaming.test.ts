import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StreamingAgentExecution } from './streaming.js';
import { CodexProvider } from '../../../domain/agents/codex.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
      usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19 },
    });
    expect(execution.metadata).toEqual({ provider: 'codex', transport: 'exec' });
  });

  it('captures thread_id from thread.started and surfaces it in metadata', async () => {
    const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: '01a13312-d9c5-7033-8230-20484caff784' });
    const result = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '<goal_complete>{"type":"goal_complete","summary":"done"}</goal_complete>',
      },
    });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(threadStarted)}); console.log(${JSON.stringify(result)})`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
      parseLine: new CodexProvider().parseLine.bind(new CodexProvider()),
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 1_000 })).resolves.toMatchObject({ status: 'completed' });
    expect(execution.metadata.threadId).toBe('01a13312-d9c5-7033-8230-20484caff784');
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

  describe('telemetryPath getter', () => {
    let tmp: string;
    const origHome = process.env.HOME;

    beforeEach(() => {
      tmp = '/tmp/afk-slug-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      mkdirSync(tmp, { recursive: true });
      process.env.HOME = tmp;
    });

    afterEach(() => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      process.env.HOME = origHome;
    });

    it('resolves to a real transcript file by deriving the correct slug', async () => {
      // Real Claude Code slug convention: leading '-' then each '/' -> '-'
      // e.g. /Users/shenggangshu/llm/afk -> -Users-shenggangshu-llm-afk
      const worktreePath = join(tmp, 'project', 'repo');
      mkdirSync(worktreePath, { recursive: true });
      const sessionId = 'c0ffee11-2222-3333-4444-555566667777';

      const execution = new StreamingAgentExecution({
        command: command(`console.log('ok')`),
        prompt: 'go',
        signalType: 'goal_complete',
        worktreePath,
        sessionId,
        metadata: PROCESS_METADATA,
      });

      const realSlug = '-' + worktreePath.split('/').filter(Boolean).join('-');
      const projectDir = join(tmp, '.claude', 'projects', realSlug);
      mkdirSync(projectDir, { recursive: true });
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(transcriptPath, '{"type":"cost-state","totalCostUSD":1,"modelUsage":{"m":{"inputTokens":100,"outputTokens":50,"thinkingTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}}\n');

      expect(execution.telemetryPath).toBe(transcriptPath);
      expect(existsSync(execution.telemetryPath!)).toBe(true);
    });

    it('maps a real project path to the slug Claude Code actually uses', () => {
      // Literal expectation, verified against real directories on disk:
      //   ls ~/.claude/projects/  ->  -Users-shenggangshu-llm-afk
      // A directory named '--Users-shenggangshu-llm-afk' does NOT exist, so a
      // doubled leading hyphen is a bug, not an equivalent spelling. Deriving the
      // expectation from the implementation's own expression cannot catch that.
      const sessionId = 'c0ffee11-2222-3333-4444-555566667777';
      const execution = new StreamingAgentExecution({
        command: command(`console.log('ok')`),
        prompt: 'go',
        signalType: 'goal_complete',
        worktreePath: '/Users/shenggangshu/llm/afk',
        sessionId,
        metadata: PROCESS_METADATA,
      });

      expect(execution.telemetryPath).toBe(
        `${process.env.HOME}/.claude/projects/-Users-shenggangshu-llm-afk/${sessionId}.jsonl`,
      );
    });
  });
});
