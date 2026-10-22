import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from './claude-code.js';
import { StreamingAgentExecution } from '../../infrastructure/sandbox/providers/streaming.js';

function command(script: string) {
  return { argv: [process.execPath, '-e', script], cwd: process.cwd() };
}

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

    await expect(execution.waitForResult({ completionTimeoutMs: 1_000 })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(execution.metadata.threadId).toBe('47444657-aaaa-4000-8000-000000000000');
  });
});
