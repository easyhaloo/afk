import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StreamingAgentExecution } from './streaming.js';
import { CodexProvider } from '../../../domain/agents/codex.js';
import { ClaudeCodeProvider } from '../../../domain/agents/claude-code.js';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function command(script: string) {
  return { argv: [process.execPath, '-e', script], cwd: process.cwd() };
}

const PROCESS_METADATA = { provider: 'claude-code', transport: 'process' } as const;

describe('StreamingAgentExecution', () => {
  it('collects Codex tools per line before output truncation and deduplicates replayed items', async () => {
    const started = { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'private command', status: 'in_progress' } };
    const completed = { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', exit_code: 3, status: 'completed', aggregated_output: 'success private output' } };
    const lines = [
      JSON.stringify(started), JSON.stringify(started), JSON.stringify(completed), JSON.stringify(completed),
      '{malformed', 'x'.repeat(6000),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<goal_complete>{"type":"goal_complete"}</goal_complete>' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', status: 'completed', arguments: { token: 'private token' }, result: { content: 'private output' } } }),
    ];
    const execution = new StreamingAgentExecution({
      command: command(`process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')})`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
      parseLine: new CodexProvider().parseLine.bind(new CodexProvider()),
    });
    execution.start();
    const result = await execution.waitForResult({ completionTimeoutMs: 10_000 });
    expect(result.status).toBe('completed');
    expect(result.tools).toEqual([
      { id: 'cmd-1', name: 'command_execution', result: 'failed', exitCode: 3 },
      { id: 'mcp-1', name: 'docs.lookup', result: 'succeeded' },
    ]);
    expect(JSON.stringify(result.tools)).not.toContain('private');
    expect(await execution.captureOutput()).not.toContain('cmd-1');
  });

  it('survives a child that exits before the prompt is delivered', async () => {
    // A child that exits without reading stdin closes the pipe, and the
    // prompt write then fails with EPIPE. That is the child's own business —
    // the exit handling reports the outcome — but with nothing listening for
    // the error it was unhandled, and it took the run with it. Vitest fails a
    // run on an unhandled error, so this passing means the broken pipe stayed
    // where it belonged.
    //
    // The exit is made to happen first. The shell leaves in a couple of
    // milliseconds, and the parent's event loop is held busy long enough that
    // the queued write cannot flush before the pipe is gone.
    const execution = new StreamingAgentExecution({
      command: { argv: ['/bin/sh', '-c', 'exit 0'], cwd: process.cwd() },
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();
    const until = Date.now() + 200;
    while (Date.now() < until) { /* hold the loop, so the write stays queued */ }

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({ status: 'failed' });
  });

  it('listens for a broken pipe on the agent process stdin', () => {
    // The race above needs the parent's event loop to be descheduled between
    // the spawn and the flush of the queued prompt write, which cannot be
    // forced from a test. What the fix actually is, though, is a listener:
    // without one the error is unhandled, and an unhandled error on a
    // socket takes the whole process down. That is the property worth
    // pinning.
    const execution = new StreamingAgentExecution({
      command: command('console.log("ready")'),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    expect((execution as unknown as { proc: { stdin: { listenerCount(event: string): number } } }).proc.stdin.listenerCount('error')).toBeGreaterThan(0);
  });

  it.each(['failed', 'missing_result', 'aborted', 'timed_out'])('returns incomplete tool metadata when %s', async status => {
    const line = JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'private command' } });
    const script = `console.log(${JSON.stringify(line)}); console.log('ready'); ${status === 'failed' ? 'process.exit(3)' : status === 'missing_result' ? '' : 'setInterval(() => {}, 10000)'}`;
    const execution = new StreamingAgentExecution({
      command: command(script), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: { provider: 'codex', transport: 'exec' },
    });
    execution.start();
    const deadline = Date.now() + 10_000;
    while (!(await execution.captureOutput()).includes('ready') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await execution.captureOutput()).toContain('ready');
    if (status === 'aborted') await execution.interrupt('manual');
    const result = await execution.waitForResult({ completionTimeoutMs: status === 'timed_out' ? 0 : 10_000 });
    expect(result.status).toBe(status === 'missing_result' ? 'failed' : status);
    expect(result.tools).toEqual([{ id: 'cmd-1', name: 'command_execution', result: 'in_progress' }]);
  });

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

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'codex fixture complete' },
      usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19 },
    });
    expect(execution.metadata).toEqual({ provider: 'codex', transport: 'exec' });
  });

  it('reads the usage of a stream that carries no provider parser', async () => {
    const usage = JSON.stringify({ type: 'usage', usage: { inputTokens: 4, outputTokens: 6 } });
    const result = JSON.stringify({
      type: 'result',
      result: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"fixture complete"}</goal_complete>',
    });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(usage)}); console.log(${JSON.stringify(result)})`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'completed',
      // The agent that ran, not the transport it ran over.
      provider: 'claude-code',
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    });
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

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({ status: 'completed' });
    expect(execution.metadata.threadId).toBe('01a13312-d9c5-7033-8230-20484caff784');
  });

  it('buffers JSONL records split across stdout chunks', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`process.stdout.write(${JSON.stringify(payload.slice(0, 20))}); setTimeout(() => process.stdout.write(${JSON.stringify(payload.slice(20) + '\n')}), 5)`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({ status: 'completed' });
  });

  it('accepts a completion marker whose payload omits the redundant type field', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"summary":"done"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
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

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
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

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
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

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: { type: 'goal_complete' },
    });
  });

  it('fails when the child exits non-zero even after emitting a result', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)}); process.exit(3)`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();
    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('includes the final stdout tail when a child exits without stderr', async () => {
    const payload = JSON.stringify({ type: 'assistant', message: 'provider failure: invalid request' });
    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(payload)}); process.exit(1)`),
      prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(),
      metadata: PROCESS_METADATA,
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'NON_ZERO_EXIT', message: expect.stringContaining('provider failure') },
    });
  });

  it('includes the final agent result when it exits successfully without a completion marker', async () => {
    const payload = JSON.stringify({ type: 'result', result: 'implemented the changes but forgot the AFK marker' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'MISSING_RESULT', message: expect.stringContaining('implemented the changes but forgot the AFK marker') },
    });
  });

  it('captures batch stdout for runtime diagnostics', async () => {
    const payload = JSON.stringify({ type: 'result', result: '<goal_complete>{"type":"goal_complete"}</goal_complete>' });
    const execution = new StreamingAgentExecution({ command: command(`console.log(${JSON.stringify(payload)})`), prompt: 'go', signalType: 'goal_complete', worktreePath: process.cwd(), metadata: PROCESS_METADATA });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({ status: 'completed' });
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
      const deadline = Date.now() + 10_000;
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
      const timer = setTimeout(() => reject(new Error('child PID was not captured')), 10_000);
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

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({ status: 'completed' });
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

      // The temp dir lives under /tmp, which is a symlink to /private/tmp on
      // macOS. Ask the filesystem where it really is rather than assuming.
      const realSlug = realpathSync(worktreePath).replace(/\//g, '-');
      const projectDir = join(tmp, '.claude', 'projects', realSlug);
      mkdirSync(projectDir, { recursive: true });
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(transcriptPath, '{"type":"cost-state","totalCostUSD":1,"modelUsage":{"m":{"inputTokens":100,"outputTokens":50,"thinkingTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}}\n');

      expect(execution.telemetryPath).toBe(transcriptPath);
      expect(existsSync(execution.telemetryPath!)).toBe(true);
    });

    it('maps a real project path to the slug Claude Code actually uses', () => {
      // Literal expectation, verified against real directories on disk. Claude
      // replaces both path separators and dots with hyphens.
      const sessionId = 'c0ffee11-2222-3333-4444-555566667777';
      const execution = new StreamingAgentExecution({
        command: command(`console.log('ok')`),
        prompt: 'go',
        signalType: 'goal_complete',
        worktreePath: '/Users/shenggangshu/.loop-workspace/github/easyhaloo/afk',
        sessionId,
        metadata: PROCESS_METADATA,
      });

      expect(execution.telemetryPath).toBe(
        `${process.env.HOME}/.claude/projects/-Users-shenggangshu--loop-workspace-github-easyhaloo-afk/${sessionId}.jsonl`,
      );
    });
  });
});

/**
 * Test must drive a real line through the same path production uses and
 * assert the id surfaces in metadata — not merely that parseLine returns a
 * session event. This mirrors the defect: codex thread_id was unit-tested
 * but never captured at runtime.
 *
 * This test would have caught:
 * - Defect 4: thread_id captured at parse time but never routed to metadata
 */
describe('ClaudeCodeProvider + StreamingAgentExecution — session_id surfaces in metadata', () => {
  const p = new ClaudeCodeProvider();

  it('populates metadata.threadId from the result event session_id', async () => {
    const resultEvent = JSON.stringify({
      type: 'result',
      session_id: '47444657-aaaa-4000-8000-000000000000',
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
      is_error: false,
      result: '<goal_complete>{"type":"goal_complete","summary":"claude session test"}</goal_complete>',
    });

    const execution = new StreamingAgentExecution({
      command: command(`console.log(${JSON.stringify(resultEvent)})`),
      prompt: 'go',
      signalType: 'goal_complete',
      worktreePath: process.cwd(),
      metadata: { provider: 'claude-code', transport: 'process' },
      parseLine: p.parseLine.bind(p),
    });
    execution.start();

    await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(execution.metadata.threadId).toBe('47444657-aaaa-4000-8000-000000000000');
  });
});
