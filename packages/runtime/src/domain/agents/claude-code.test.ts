import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeProvider } from './claude-code.js';
import { CursorProvider } from './cursor.js';
import { CodexProvider } from './codex.js';
import { CodexAppServerExecution } from './codex-app-server/execution.js';
import { StreamingAgentExecution } from '../../infrastructure/sandbox/providers/streaming.js';

function command(script: string) {
  return { argv: [process.execPath, '-e', script], cwd: process.cwd() };
}

describe('restricted analysis profile', () => {
  it('disables customizations and all tools without bypassing permissions or disabling OAuth', () => {
    const provider = new ClaudeCodeProvider();
    const built = provider.buildCommand({ worktreePath: '/tmp/analysis', sessionId: 'fresh',
      executionMode: 'batch', executionProfile: 'analysis' });
    expect(provider.capabilities.has('analysis')).toBe(true);
    expect(built.argv).not.toContain('--dangerously-skip-permissions');
    expect(built.argv).not.toContain('--bare');
    expect(built.argv).not.toContain('--max-turns');
    expect(built.argv[built.argv.indexOf('--session-id') + 1]).toBe('fresh');
    for (const flag of ['--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--no-chrome']) {
      expect(built.argv).toContain(flag);
    }
    expect(built.argv[built.argv.indexOf('--tools') + 1]).toBe('');
    expect(built.argv[built.argv.indexOf('--setting-sources') + 1]).toBe('user');
    expect(built.argv[built.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(JSON.parse(built.argv[built.argv.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: {} });
    expect(JSON.parse(built.argv[built.argv.indexOf('--settings') + 1]!)).toMatchObject({ disableAllHooks: true });
    expect(built.cwd).toBe('/tmp/analysis');
  });

  it('refuses interactive analysis and preserves existing development command behavior', () => {
    const provider = new ClaudeCodeProvider();
    expect(() => provider.buildCommand({ worktreePath: '/tmp/analysis', sessionId: 'fresh',
      executionMode: 'interactive', executionProfile: 'analysis' })).toThrow(/batch/i);
    expect(provider.buildCommand({ worktreePath: '/tmp/worktree', sessionId: 'development',
      executionMode: 'batch' }).argv).toContain('--dangerously-skip-permissions');
  });

  it('refuses unsupported analysis before starting a process', async () => {
    const startAgent = vi.fn();
    const provider = new CursorProvider();
    await expect(provider.createExecution({ worktreePath: '/tmp/analysis', sessionId: 'fresh',
      executionMode: 'batch', executionProfile: 'analysis', prompt: 'Extract facts',
      signalType: 'goal_complete', generation: 1, sandbox: { startAgent } as never })).rejects.toThrow('analysis_unsupported');
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('does not bypass analysis restrictions through the Codex app-server transport', async () => {
    const start = vi.spyOn(CodexAppServerExecution, 'start').mockResolvedValue({} as never);
    try {
      await expect(new CodexProvider().createExecution({ worktreePath: '/tmp/analysis', sessionId: 'fresh',
        executionMode: 'batch', executionProfile: 'analysis', prompt: 'Extract facts',
        signalType: 'goal_complete', generation: 1, sandbox: { startAgent: vi.fn() } as never,
        runtime: { kind: 'codex', transport: 'app-server', auth: 'unknown', provider: 'auto', startupTimeoutMs: 1000 },
      })).rejects.toThrow('analysis_unsupported');
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); }
  });

  it('passes the restricted command to the execution host', async () => {
    const startAgent = vi.fn();
    await new ClaudeCodeProvider().createExecution({ worktreePath: '/tmp/analysis', sessionId: 'fresh',
      executionMode: 'batch', executionProfile: 'analysis', prompt: 'Extract facts',
      signalType: 'goal_complete', generation: 1, sandbox: { startAgent } as never });
    expect(startAgent).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch',
      command: expect.objectContaining({ argv: expect.arrayContaining(['--safe-mode', '--no-session-persistence']) }) }));
  });
});

/**
 * The terminal `result` event carries the finished aggregate. Before this
 * change `parseLine` read only `parsed.result` and `parsed.is_error`, so the
 * usage fields on that same line were discarded and batch runs reported none.
 *
 * Field names and values below are copied verbatim from a real headless run
 * (`claude --print --output-format stream-json --verbose`), not invented.
 */
const RESULT_EVENT = JSON.stringify({
  type: 'result',
  session_id: '47444657-0000-4000-8000-000000000000',
  total_cost_usd: 0.15559125000000001,
  usage: {
    input_tokens: 5252,
    cache_creation_input_tokens: 20569,
    cache_read_input_tokens: 0,
    output_tokens: 31,
    output_tokens_details: { thinking_tokens: 29 },
  },
  num_turns: 1,
  duration_ms: 2723,
  is_error: false,
  result: 'PONG',
});

describe('ClaudeCodeProvider.parseLine — terminal result usage', () => {
  const p = new ClaudeCodeProvider();

  it('extracts token usage from the result event', () => {
    const events = p.parseLine(RESULT_EVENT);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
  });

  it('counts cache tokens as input, not as a separate bucket', () => {
    // Claude Code reports input_tokens EXCLUDING cache creation/read.
    // 5252 alone would under-report this run by ~80%.
    const usage = p.parseLine(RESULT_EVENT).find((e) => e.type === 'usage');
    expect(usage).toMatchObject({
      usage: { inputTokens: 5252 + 20569 + 0, outputTokens: 31 },
    });
  });

  it('does not add thinking tokens on top of output_tokens', () => {
    // thinking_tokens is a breakdown OF output_tokens, not additional to it.
    const usage = p.parseLine(RESULT_EVENT).find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { outputTokens: 31 } });
  });

  it('sets totalTokens to input plus output', () => {
    const usage = p.parseLine(RESULT_EVENT).find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { totalTokens: 5252 + 20569 + 31 } });
  });

  it('still emits the result event', () => {
    const events = p.parseLine(RESULT_EVENT);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('treats a result event without usage as having no usage', () => {
    const events = p.parseLine(JSON.stringify({ type: 'result', result: 'ok', is_error: false }));
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});

/**
 * The `/goal` condition of Claude Code's TUI is refused above 4,000
 * characters, and the refusal is silent: the TUI prints one line, the agent
 * never starts, and the runner only learns about it when the idle timeout
 * expires. The provider declares the limit and refuses an over-long goal
 * itself, before any agent is started.
 */
describe('ClaudeCodeProvider — goal condition limit', () => {
  const p = new ClaudeCodeProvider();

  function sandbox() {
    const startAgent = vi.fn();
    return { startAgent, host: { worktreePath: process.cwd(), workspacePath: process.cwd(), startAgent } as never };
  }

  it('declares the limit its TUI enforces', () => {
    expect(p.promptLimits?.goalConditionMaxChars).toBe(4000);
  });

  it('refuses an over-long goal before the agent is started', async () => {
    const s = sandbox();

    await expect(p.createExecution({
      sandbox: s.host,
      worktreePath: process.cwd(),
      sessionId: 'session-1',
      prompt: `/goal ${'x'.repeat(4001)}`,
      signalType: 'goal_complete',
      generation: 1,
      executionMode: 'interactive',
    })).rejects.toThrow(/goal condition is 4001 characters/);
    expect(s.startAgent).not.toHaveBeenCalled();
  });

  it('starts the agent for a goal within the limit', async () => {
    const s = sandbox();

    await p.createExecution({
      sandbox: s.host,
      worktreePath: process.cwd(),
      sessionId: 'session-1',
      prompt: `/goal ${'x'.repeat(4000)}`,
      signalType: 'goal_complete',
      generation: 1,
      executionMode: 'interactive',
    });
    expect(s.startAgent).toHaveBeenCalled();
  });
});

/**
 * session_id lives on the same `result` event as usage — verified on a real run:
 * `{"type":"result","session_id":"47444657-…", …}`.
 * The value is captured as an AgentEvent of type 'session', which
 * StreamingAgentExecution.routes to metadata.threadId (mirroring codex).
 */
describe('ClaudeCodeProvider.parseLine — session_id on result event', () => {
  const p = new ClaudeCodeProvider();

  it('emits a session event with the session_id from the result line', () => {
    const events = p.parseLine(RESULT_EVENT);
    const session = events.find((e) => e.type === 'session');
    expect(session).toMatchObject({ type: 'session', sessionId: '47444657-0000-4000-8000-000000000000' });
  });

  it('does not emit a session event when session_id is absent', () => {
    const noSession = JSON.stringify({ type: 'result', result: 'ok', is_error: false });
    const events = p.parseLine(noSession);
    expect(events.some((e) => e.type === 'session')).toBe(false);
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

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(execution.metadata.threadId).toBe('47444657-aaaa-4000-8000-000000000000');
  });
});
