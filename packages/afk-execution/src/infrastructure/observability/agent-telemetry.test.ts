import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectAgentTelemetry, extractClaudeSessionId, extractClaudeTranscriptTokens, extractCodexRolloutTokens, extractOpenCodeTranscriptTokens, readAgentTelemetry, readAgentTools, extractCodexToolEvents, findCodexRollout, resolveAgentTranscript } from './agent-telemetry.js';
import type { AgentExecution, ExecutionResult } from '../../domain/agents/types.js';
import { mkdirSync, writeFileSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: childProcessMocks.execFile }));

describe('collectAgentTelemetry', () => {
  let directory: string;
  let transcriptPath: string;

  beforeEach(() => {
    directory = '/tmp/afk-collect-telemetry-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    mkdirSync(directory, { recursive: true });
    transcriptPath = join(directory, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      { session_id: 'native-session' },
      { type: 'cost-state', totalCostUSD: 1, modelUsage: { model: { inputTokens: 10, outputTokens: 5 } } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash' }] } },
    ].map(event => JSON.stringify(event)).join('\n'));
  });

  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  /** The execution the harness reports, plus the transcript path it writes. */
  function execution(provider: AgentExecution['metadata']['provider'] = 'claude-code'): AgentExecution {
    return {
      id: 'execution-1',
      metadata: { provider, transport: 'process' },
      waitForResult: async () => result,
      interrupt: async () => {},
      kill: async () => {},
      captureOutput: async () => '',
      captureSession: async () => undefined,
      telemetryPath: transcriptPath,
    };
  }

  const result: ExecutionResult = { version: 1, runId: 'execution-1', status: 'completed', provider: 'claude-code', commits: [] };

  it('reads the transcript through the contract, not through a cast', async () => {
    // The provider knows where its transcript is and the telemetry reader
    // needs it, so the path is on the contract — the reader asks for it
    // there, and a provider that has none simply does not offer one.
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    await expect(collectAgentTelemetry(execution(), { ...result, usage, tools: [] }, 'local')).resolves.toMatchObject({
      transcriptPath,
      usage,
    });
    const withoutTranscript: AgentExecution = { ...execution(), telemetryPath: undefined };
    const read = await collectAgentTelemetry(withoutTranscript, { ...result, usage, tools: [] }, 'local');
    expect(read.usage).toEqual(usage);
    expect(read).not.toHaveProperty('transcriptPath');
  });

  it('preserves explicit zero usage and empty tools over transcript data', async () => {
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    await expect(collectAgentTelemetry(execution(), { ...result, usage, tools: [] }, 'local')).resolves.toEqual({
      sessionId: 'native-session', transcriptPath, usage, tools: [],
    });
  });

  it('fills missing usage without replacing native tools', async () => {
    const tools = [{ id: 'native-tool', name: 'Bash', result: 'failed' as const }];
    await expect(collectAgentTelemetry(execution(), { ...result, tools }, 'local')).resolves.toEqual({
      sessionId: 'native-session', transcriptPath, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, tools,
    });
  });

  it.each(['cursor', 'pi', 'copilot'] as const)('does not read a Claude transcript for %s', async provider => {
    await expect(collectAgentTelemetry(execution(provider), { ...result, sessionId: 'result-session' }, 'local')).resolves.toEqual({
      sessionId: 'result-session', usage: undefined, tools: undefined,
    });
  });

  it('keeps missing container usage absent and prefers the native thread identity', async () => {
    const agent = execution();
    agent.metadata.threadId = 'thread-1';
    await expect(collectAgentTelemetry(agent, { ...result, sessionId: 'runner-session' }, 'container')).resolves.toEqual({
      sessionId: 'thread-1', usage: undefined, tools: undefined,
    });
  });

  it('keeps unreadable local telemetry absent without inventing zero usage', async () => {
    rmSync(transcriptPath);
    await expect(collectAgentTelemetry(execution(), result, 'local')).resolves.toEqual({
      sessionId: 'execution-1', usage: undefined, tools: undefined,
    });
  });
});

/**
 * Fixtures mirror a real session (`c03ff1c4-…`), whose cost-state sequence was
 * non-monotonic: [96.89, 412.79, 96.89]. Entry 1 is the genuine peak; entry 2 is
 * a snapshot reset that re-emitted entry 0's totals verbatim. Measured across 41
 * multi-entry sessions, MAX(totalCostUSD) picked the right snapshot every time.
 */
const SNAPSHOT_LOW = {
  type: 'cost-state',
  totalCostUSD: 96.89240524999988,
  modelUsage: {
    'MiniMax-M2.7': {
      inputTokens: 9_204_607,
      outputTokens: 164_346,
      thinkingTokens: 0,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 200,
    },
  },
};

const SNAPSHOT_PEAK = {
  type: 'cost-state',
  totalCostUSD: 412.79623625000016,
  modelUsage: {
    'MiniMax-M2.7': {
      inputTokens: 46_546_506,
      outputTokens: 413_939,
      thinkingTokens: 0,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 400,
    },
    'MiniMax-M3': {
      inputTokens: 5_856_794,
      outputTokens: 196_906,
      thinkingTokens: 0,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 600,
    },
  },
};

/** Peak totals: (46_546_506+300+400+413_939) + (5_856_794+500+600+196_906) */
const PEAK_INPUT = 46_546_506 + 300 + 400 + 5_856_794 + 500 + 600;
const PEAK_OUTPUT = 413_939 + 196_906;

const attachment = (n: number) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'skill', name: `s${n}` } });

const NON_MONOTONIC = [
  attachment(1),
  JSON.stringify(SNAPSHOT_LOW),
  attachment(2),
  JSON.stringify(SNAPSHOT_PEAK),
  JSON.stringify(SNAPSHOT_LOW),
  attachment(3),
];

describe('extractClaudeTranscriptTokens', () => {
  it('picks the highest-cost snapshot, not the last one', () => {
    // Last-wins would return the reset snapshot and under-report by ~4x.
    expect(extractClaudeTranscriptTokens(NON_MONOTONIC)).toEqual({
      inputTokens: PEAK_INPUT,
      outputTokens: PEAK_OUTPUT,
      totalTokens: PEAK_INPUT + PEAK_OUTPUT,
    });
  });

  it('ignores non cost-state entries', () => {
    // Attachments are the bulk of a real transcript — 19 of 37 lines.
    const withOnlyAttachments = [attachment(1), attachment(2), attachment(3)];
    expect(extractClaudeTranscriptTokens(withOnlyAttachments)).toBeUndefined();
  });

  it('sums cache tokens into input rather than dropping them', () => {
    const usage = extractClaudeTranscriptTokens([JSON.stringify(SNAPSHOT_PEAK)]);
    expect(usage?.inputTokens).toBe(PEAK_INPUT);
  });

  it('does not add thinking tokens on top of output', () => {
    const withThinking = JSON.stringify({
      type: 'cost-state',
      totalCostUSD: 1,
      modelUsage: { m: { inputTokens: 10, outputTokens: 20, thinkingTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    });
    expect(extractClaudeTranscriptTokens([withThinking])).toMatchObject({ outputTokens: 20 });
  });

  it('returns undefined when the transcript has no cost-state', () => {
    expect(extractClaudeTranscriptTokens([attachment(1), JSON.stringify({ type: 'assistant' })])).toBeUndefined();
  });

  it('survives a truncated trailing line without throwing', () => {
    // Transcript writes are eventually consistent; a partial last line is normal.
    const truncated = [...NON_MONOTONIC, '{"type":"cost-sta'];
    expect(() => extractClaudeTranscriptTokens(truncated)).not.toThrow();
    expect(extractClaudeTranscriptTokens(truncated)).toMatchObject({ totalTokens: PEAK_INPUT + PEAK_OUTPUT });
  });

  it('returns undefined for an empty transcript', () => {
    expect(extractClaudeTranscriptTokens([])).toBeUndefined();
  });

  it('avoids NaN when inner fields are missing from modelUsage', () => {
    // Harness may emit cost-state with some token fields absent.
    const incompleteModel = {
      type: 'cost-state',
      totalCostUSD: 1,
      modelUsage: {
        m: { inputTokens: 10, outputTokens: 20 }, // missing cache fields entirely
      },
    };
    const usage = extractClaudeTranscriptTokens([JSON.stringify(incompleteModel)]);
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(20);
    expect(Number.isNaN(usage?.totalTokens)).toBe(false);
  });
});

describe('extractCodexRolloutTokens', () => {
  // Real Codex token_count is nested inside event_msg.payload.
  // Derived from ~/.codex/sessions/2026/09/03/rollout-... (real session).
  const tokenCount = (n: number) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: n * 100,
            output_tokens: n * 10,
            reasoning_output_tokens: 0,
            cached_input_tokens: n * 5,
            cache_write_input_tokens: n * 2,
            total_tokens: n * 117,
          },
        },
      },
    });

  it('takes the last token_count entry (not the max)', () => {
    // LAST and MAX agree across all 654 real rollouts (0 disagreements).
    // Claude uses MAX (non-monotonic snapshots); Codex uses LAST (cumulative).
    const lines = [tokenCount(1), tokenCount(3), tokenCount(2)];
    const usage = extractCodexRolloutTokens(lines);
    // Last entry is tokenCount(2): input=200+10+4=214, output=20
    expect(usage).toEqual({ inputTokens: 214, outputTokens: 20, totalTokens: 234 });
  });

  it('returns undefined when no token_count entries exist', () => {
    expect(extractCodexRolloutTokens(['{"type":"turn.completed"}'])).toBeUndefined();
  });

  it('sums cache tokens into input', () => {
    const lines = [JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            output_tokens: 200,
            reasoning_output_tokens: 0,
            cached_input_tokens: 50,
            cache_write_input_tokens: 25,
            total_tokens: 1275,
          },
        },
      },
    })];
    const usage = extractCodexRolloutTokens(lines);
    expect(usage).toEqual({ inputTokens: 1075, outputTokens: 200, totalTokens: 1275 });
  });

  it('survives a truncated trailing line without throwing', () => {
    const lines = [tokenCount(2), '{"type":"token_coun'];
    expect(() => extractCodexRolloutTokens(lines)).not.toThrow();
    expect(extractCodexRolloutTokens(lines)).toEqual({ inputTokens: 214, outputTokens: 20, totalTokens: 234 });
  });

  it('returns undefined for an empty rollout', () => {
    expect(extractCodexRolloutTokens([])).toBeUndefined();
  });

  it('avoids NaN when cache fields are missing', () => {
    const entry = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            output_tokens: 200,
            reasoning_output_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            total_tokens: 1200,
          },
        },
      },
    });
    const usage = extractCodexRolloutTokens([entry]);
    expect(usage?.inputTokens).toBe(1000);
    expect(usage?.outputTokens).toBe(200);
    expect(Number.isNaN(usage?.totalTokens)).toBe(false);
  });

  it('returns undefined when info is null (real Codex data has this)', () => {
    const entry = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
      },
    });
    expect(extractCodexRolloutTokens([entry])).toBeUndefined();
  });

  it('returns undefined when total_token_usage is absent', () => {
    const entry = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: {} },
      },
    });
    expect(extractCodexRolloutTokens([entry])).toBeUndefined();
  });
});

describe('readAgentTelemetry', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = '/tmp/afk-telemetry-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns undefined for container sandbox (no HOME access)', async () => {
    const usage = await readAgentTelemetry({ provider: 'claude-code', transcriptPath: '/nonsense/nonexistent', sandboxKind: 'container' });
    expect(usage).toBeUndefined();
  });

  it('returns undefined when transcript file does not exist', async () => {
    const usage = await readAgentTelemetry({ provider: 'claude-code', transcriptPath: '/tmp/this-file-does-not-exist-xyz', sandboxKind: 'local' });
    expect(usage).toBeUndefined();
  });

  it('reads and parses a Claude transcript', async () => {
    const transcriptPath = join(tmp, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      '{"type":"attachment","attachment":{"type":"skill","name":"s1"}}',
      JSON.stringify(SNAPSHOT_PEAK),
    ].join('\n'));
    const usage = await readAgentTelemetry({ provider: 'claude-code', transcriptPath, sandboxKind: 'local' });
    expect(usage).toEqual({ inputTokens: PEAK_INPUT, outputTokens: PEAK_OUTPUT, totalTokens: PEAK_INPUT + PEAK_OUTPUT });
  });

  it('reads native tools from a transcript independently of token usage', async () => {
    const transcriptPath = join(tmp, 'tools.jsonl');
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'private' } }] } }),
      '{malformed',
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'private output' }] } }),
    ].join('\n'));
    await expect(readAgentTools({ provider: 'claude-code', transcriptPath, sandboxKind: 'local' })).resolves.toEqual([
      { id: 'call-1', name: 'Read', result: 'succeeded' },
    ]);
    await expect(readAgentTelemetry({ provider: 'claude-code', transcriptPath, sandboxKind: 'local' })).resolves.toBeUndefined();
  });

  it('leaves unavailable native tool telemetry absent and re-exports the CLI parser', async () => {
    const transcriptPath = join(tmp, 'rollout.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }));
    await expect(readAgentTools({ provider: 'codex', transcriptPath, sandboxKind: 'local' })).resolves.toBeUndefined();
    await expect(readAgentTools({ provider: 'codex', transcriptPath: join(tmp, 'missing'), sandboxKind: 'local' })).resolves.toBeUndefined();
    await expect(readAgentTools({ provider: 'codex', transcriptPath, sandboxKind: 'container' })).resolves.toBeUndefined();
    const cliLine = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd-1', exit_code: 2 } });
    writeFileSync(transcriptPath, cliLine);
    const expected = [{ id: 'cmd-1', name: 'command_execution', result: 'failed', exitCode: 2 }];
    await expect(readAgentTools({ provider: 'codex', transcriptPath, sandboxKind: 'local' })).resolves.toEqual(expected);
    expect(extractCodexToolEvents([cliLine])).toEqual(expected);
  });
});

describe('findCodexRollout', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = '/tmp/afk-codex-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns undefined when no rollout matches thread_id', async () => {
    const path = await findCodexRollout('nonexistent-thread-id-xyz');
    expect(path).toBeUndefined();
  });

  it('locates rollout by thread_id suffix glob', async () => {
    const sessionsDir = join(tmp, '.codex', 'sessions', '2025', '01', '15');
    mkdirSync(sessionsDir, { recursive: true });
    const rolloutFile = join(sessionsDir, 'rollout-103000-abc123def456.jsonl');
    writeFileSync(rolloutFile, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 0, cached_input_tokens: 5, cache_write_input_tokens: 2, total_tokens: 127 } } } }) + '\n');

    const found = await findCodexRollout('abc123def456', tmp);
    expect(found).toBe(rolloutFile);
  });
});

describe('resolveAgentTranscript', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = '/tmp/afk-transcript-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    mkdirSync(tmp, { recursive: true });
    vi.stubEnv('HOME', tmp);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns the original transcript and reads subsequent provider updates without creating a copy', async () => {
    const source = join(tmp, 'very', 'long', 'claude', 'project', 'afk-session.jsonl');
    mkdirSync(join(tmp, 'very', 'long', 'claude', 'project'), { recursive: true });
    writeFileSync(source, [
      JSON.stringify({ type: 'assistant', session_id: 'agent-session-123' }),
      JSON.stringify({ type: 'cost-state', totalCostUSD: 1, modelUsage: {} }),
    ].join('\n'));

    const resolved = await resolveAgentTranscript({
      provider: 'claude-code',
      telemetryPath: source,
    });

    expect(resolved).toEqual({
      sessionId: 'agent-session-123',
      path: source,
    });
    expect(existsSync(join(tmp, '.afk'))).toBe(false);
    appendFileSync(source, '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'new-tool', name: 'Read', input: {} }] } }));
    await expect(readAgentTools({ provider: 'claude-code', transcriptPath: resolved!.path, sandboxKind: 'local' })).resolves.toEqual([
      { id: 'new-tool', name: 'Read', result: 'unknown' },
    ]);
  });

  it('locates the original transcript by the runtime provider session id instead of the newest file', async () => {
    const projectDir = join(tmp, 'claude-project');
    mkdirSync(projectDir, { recursive: true });
    const source = join(projectDir, 'agent-session-456.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'assistant', session_id: 'agent-session-456' }));
    writeFileSync(join(projectDir, 'unrelated-session.jsonl'), JSON.stringify({ session_id: 'unrelated-session' }));

    const resolved = await resolveAgentTranscript({
      provider: 'claude-code',
      telemetryPath: join(projectDir, 'qa-204-1791984447541.jsonl'),
      threadId: 'agent-session-456',
    });

    expect(resolved?.sessionId).toBe('agent-session-456');
    expect(resolved?.path).toBe(source);
  });

  it('leaves a missing transcript unresolved even when another session exists in the same project', async () => {
    writeFileSync(join(tmp, 'unrelated-session.jsonl'), JSON.stringify({ session_id: 'unrelated-session' }));
    await expect(resolveAgentTranscript({
      provider: 'claude-code', telemetryPath: join(tmp, 'missing-session.jsonl'),
    })).resolves.toBeUndefined();
  });

  it('rejects a transcript whose session id conflicts with the runtime provider session id', async () => {
    const source = join(tmp, 'expected-session.jsonl');
    writeFileSync(source, JSON.stringify({ session_id: 'different-session' }));
    await expect(resolveAgentTranscript({
      provider: 'claude-code', telemetryPath: source, threadId: 'expected-session',
    })).resolves.toBeUndefined();
  });

  it('returns the original Codex rollout without creating a copy', async () => {
    const sessionsDir = join(tmp, '.codex', 'sessions', '2026', '10', '17');
    mkdirSync(sessionsDir, { recursive: true });
    const source = join(sessionsDir, 'rollout-103000-thread-123.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-123' } }));
    await expect(resolveAgentTranscript({ provider: 'codex', threadId: 'thread-123' })).resolves.toEqual({
      sessionId: 'thread-123', path: source,
    });
    expect(existsSync(join(tmp, '.afk'))).toBe(false);
  });

  it('reads the original OpenCode provider export without creating a copy', async () => {
    vi.stubEnv('XDG_DATA_HOME', tmp);
    const messageDir = join(tmp, 'opencode', 'storage', 'message', 'ses_original');
    const partDir = join(tmp, 'opencode', 'storage', 'part', 'msg-1');
    mkdirSync(messageDir, { recursive: true });
    mkdirSync(partDir, { recursive: true });
    writeFileSync(join(messageDir, 'msg-1.json'), JSON.stringify({ id: 'msg-1', sessionID: 'ses_original', role: 'assistant', tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } }));
    writeFileSync(join(partDir, 'part-1.json'), JSON.stringify({ type: 'tool', callID: 'call-1', tool: 'read', state: { status: 'completed' } }));

    const resolved = await resolveAgentTranscript({ provider: 'opencode', threadId: 'ses_original' });

    expect(resolved).toEqual({ sessionId: 'ses_original', path: messageDir });
    await expect(readAgentTelemetry({ provider: 'opencode', transcriptPath: resolved!.path, sandboxKind: 'local' })).resolves.toEqual({ inputTokens: 14, outputTokens: 7, totalTokens: 21 });
    await expect(readAgentTools({ provider: 'opencode', transcriptPath: resolved!.path, sandboxKind: 'local' })).resolves.toEqual([{ id: 'call-1', name: 'read', result: 'succeeded' }]);
    expect(existsSync(join(tmp, '.afk'))).toBe(false);
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('reads a database-only OpenCode session through the provider database command', async () => {
    childProcessMocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: null, result: { stdout: string; stderr: string }) => void) => {
      const isSessionQuery = args[1]?.includes('from session');
      const isMessageQuery = args[1]?.includes('from message');
      const stdout = isSessionQuery
        ? JSON.stringify([{ tokens_input: 10, tokens_output: 5, tokens_reasoning: 1, tokens_cache_read: 2, tokens_cache_write: 0 }])
        : isMessageQuery
        ? JSON.stringify([{ id: 'msg-db', role: 'assistant', tokens: JSON.stringify({ input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } }) }])
        : JSON.stringify([{ message_id: 'msg-db', call_id: 'call-db', tool: 'bash', status: 'completed' }]);
      callback(null, { stdout, stderr: '' });
    });

    const resolved = await resolveAgentTranscript({ provider: 'opencode', threadId: 'ses_db' });

    expect(resolved).toEqual({ sessionId: 'ses_db', path: 'opencode://session/ses_db' });
    await expect(readAgentTelemetry({ provider: 'opencode', transcriptPath: resolved!.path, sandboxKind: 'local' })).resolves.toEqual({ inputTokens: 12, outputTokens: 6, totalTokens: 18 });
    await expect(readAgentTools({ provider: 'opencode', transcriptPath: resolved!.path, sandboxKind: 'local' })).resolves.toEqual([{ id: 'call-db', name: 'bash', result: 'succeeded' }]);
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(6);
  });
});
