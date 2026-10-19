import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderBundle } from '@afk/infrastructure';
import { WorkflowRunner } from '@afk/execution/application/workflow-engine';
import type { RunObserver } from '@afk/execution/observability/run-observer';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tests for agent.session_recorded wiring in WorkflowRunner.
 *
 * Verifies:
 * 1. result.usage is used directly (no file read needed)
 * 2. Falls back to transcript file when result.usage is absent
 * 3. Container sandbox preserves native telemetry without reading host transcripts
 */

function mockContext() {
  return {
    traceId: 'trace-1',
    runId: 'run-1',
    workItemId: '42',
    profileId: 'test',
    attempt: 1,
    actor: { kind: 'system' as const, id: 'session-1' },
  };
}

describe('agent.session_recorded wiring', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = '/tmp/afk-telemetry-wiring-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    mkdirSync(tmp, { recursive: true });
    vi.stubEnv('HOME', tmp);
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.unstubAllEnvs();
  });

  it('prefers result.usage over file read when result.usage is present', async () => {
    // result.usage is already normalized from stream (AC1).
    // recordAgentTelemetry must use it directly without triggering file I/O.
    const record = vi.fn(async () => ({ lastSequence: 1 }));
    const observer = { record } as unknown as RunObserver;
    const claim = vi.fn(async () => null);

    const runner = new WorkflowRunner(
      { backlog: { claim } } as unknown as ProviderBundle,
      {
        observer,
        agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
      },
    );

    // Inject observationContext via prototype (normally set during run())
    Object.defineProperty(runner, 'observationContext', { value: mockContext(), writable: true, configurable: true });
    Object.defineProperty(runner, 'sandboxProviderName', { value: 'local', writable: true, configurable: true });
    Object.defineProperty(runner, 'agentProviderName', { value: 'claude-code', writable: true, configurable: true });

    const execution = {
      id: 'exec-1',
      sessionId: 'session-abc',
      metadata: { provider: 'claude-code', transport: 'process' as const },
      telemetryPath: join(tmp, 'transcript.jsonl'),
    } as any;
    writeFileSync(execution.telemetryPath, JSON.stringify({ session_id: 'session-abc' }) + '\n');

    const result = {
      version: 1 as const,
      runId: 'exec-1',
      status: 'completed' as const,
      provider: 'local',
      sessionId: 'session-abc',
      usage: { inputTokens: 5000, outputTokens: 200, totalTokens: 5200 },
      commits: [] as string[],
    };

    await (runner as any).recordAgentTelemetry(execution, result);

    expect(record).toHaveBeenCalledTimes(1);
    const [, data] = record.mock.calls[0]!;
    expect(data.kind).toBe('agent.session_recorded');
    expect(data.sessionId).toBe('session-abc');
    expect(data.transcriptPath).toBe(execution.telemetryPath);
    expect(data.usage).toEqual({ inputTokens: 5000, outputTokens: 200, totalTokens: 5200 });
  });

  it('falls back to transcript file when result.usage is absent (interactive path)', async () => {
    // Interactive/tmux: no stdout stream, result.usage is undefined.
    // recordAgentTelemetry must read the transcript file.
    const transcriptPath = join(tmp, 'transcript.jsonl');
    writeFileSync(transcriptPath, [JSON.stringify({ session_id: 'agent-session-xyz' }), JSON.stringify({
      type: 'cost-state',
      totalCostUSD: 1.5,
      modelUsage: {
        'm': { inputTokens: 1000, outputTokens: 50, thinkingTokens: 0, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
      },
    })].join('\n') + '\n');

    const record = vi.fn(async () => ({ lastSequence: 1 }));
    const observer = { record } as unknown as RunObserver;
    const claim = vi.fn(async () => null);

    const runner = new WorkflowRunner(
      { backlog: { claim } } as unknown as ProviderBundle,
      {
        observer,
        agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
      },
    );

    Object.defineProperty(runner, 'observationContext', { value: mockContext(), writable: true, configurable: true });
    Object.defineProperty(runner, 'sandboxProviderName', { value: 'local', writable: true, configurable: true });
    Object.defineProperty(runner, 'agentProviderName', { value: 'claude-code', writable: true, configurable: true });

    const execution = {
      id: 'exec-2',
      sessionId: 'session-xyz',
      metadata: { provider: 'claude-code', transport: 'process' as const },
      telemetryPath: transcriptPath,
    } as any;

    const result = {
      version: 1 as const,
      runId: 'exec-2',
      status: 'completed' as const,
      provider: 'local',
      sessionId: 'session-xyz',
      usage: undefined, // no stream usage — must read file
      commits: [] as string[],
    };

    await (runner as any).recordAgentTelemetry(execution, result);

    expect(record).toHaveBeenCalledTimes(1);
    const [, data] = record.mock.calls[0]!;
    expect(data.kind).toBe('agent.session_recorded');
    expect(data.sessionId).toBe('agent-session-xyz');
    expect(data.transcriptPath).toBe(transcriptPath);
    expect(data.usage?.inputTokens).toBe(1015); // 1000 + 10 + 5
    expect(data.usage?.outputTokens).toBe(50);
  });

  it('reads Codex native telemetry when a step overrides the default Claude provider', async () => {
    const rolloutDirectory = join(tmp, '.codex', 'sessions', '2026', '10', '18');
    mkdirSync(rolloutDirectory, { recursive: true });
    const transcriptPath = join(rolloutDirectory, 'rollout-test-thread-abc123.jsonl');
    writeFileSync(transcriptPath, [
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } } },
      { type: 'item.completed', item: { id: 'call-1', type: 'command_execution', exit_code: 0 } },
    ].map(event => JSON.stringify(event)).join('\n'));

    const record = vi.fn(async () => ({ lastSequence: 1 }));
    const observer = { record } as unknown as RunObserver;
    const claim = vi.fn(async () => null);

    const runner = new WorkflowRunner(
      { backlog: { claim } } as unknown as ProviderBundle,
      {
        observer,
        agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
      },
    );

    Object.defineProperty(runner, 'observationContext', { value: mockContext(), writable: true, configurable: true });
    Object.defineProperty(runner, 'sandboxProviderName', { value: 'local', writable: true, configurable: true });
    Object.defineProperty(runner, 'agentProviderName', { value: 'claude-code', writable: true, configurable: true });

    // telemetryPath is undefined (exec transport has no sessionId)
    // but threadId is present in metadata
    const execution = {
      id: 'exec-codex',
      sessionId: 'codex-session',
      metadata: { provider: 'codex', transport: 'exec' as const, threadId: 'thread-abc123' },
      // telemetryPath deliberately absent — simulates exec transport
    } as any;

    const result = {
      version: 1 as const,
      runId: 'exec-codex',
      status: 'completed' as const,
      provider: 'local',
      sessionId: 'codex-session',
      usage: undefined,
      commits: [] as string[],
    };

    await expect((runner as any).recordAgentTelemetry(execution, result)).resolves.toEqual({ sessionId: 'thread-abc123', totalTokens: 15 });
    const [, data] = record.mock.calls[0]!;
    expect(data.sessionId).toBe('thread-abc123');
    expect(data.transcriptPath).toBe(transcriptPath);
    expect(data.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(data.tools).toEqual([{ id: 'call-1', name: 'command_execution', result: 'succeeded', exitCode: 0 }]);
  });

  it.each(['docker', 'podman'])('preserves native telemetry in %s without reading host transcripts', async sandboxProvider => {
    const record = vi.fn(async () => ({ lastSequence: 1 }));
    const observer = { record } as unknown as RunObserver;
    const claim = vi.fn(async () => null);

    const runner = new WorkflowRunner(
      { backlog: { claim } } as unknown as ProviderBundle,
      {
        observer,
        agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
      },
    );

    Object.defineProperty(runner, 'observationContext', { value: mockContext(), writable: true, configurable: true });
    Object.defineProperty(runner, 'sandboxProvider', { value: { name: sandboxProvider }, writable: true, configurable: true });
    Object.defineProperty(runner, 'agentProviderName', { value: 'claude-code', writable: true, configurable: true });

    const execution = {
      id: 'exec-3',
      sessionId: 'session-docker',
      metadata: { provider: 'claude-code', transport: 'process' as const },
      telemetryPath: join(tmp, 'host-transcript.jsonl'),
    } as any;
    writeFileSync(execution.telemetryPath, JSON.stringify({ session_id: 'unrelated-host-session' }));

    const result = {
      version: 1 as const,
      runId: 'exec-3',
      status: 'completed' as const,
      provider: 'container',
      sessionId: 'session-docker',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      tools: [{ id: 'call-1', name: 'Bash', result: 'failed' as const }],
      commits: [] as string[],
    };

    await expect((runner as any).recordAgentTelemetry(execution, result)).resolves.toEqual({ sessionId: 'session-docker', totalTokens: 15 });
    expect(record).toHaveBeenCalledWith(mockContext(), {
      kind: 'agent.session_recorded', sessionId: 'session-docker', usage: result.usage, tools: result.tools,
    });
  });

  it('reads tool results from a transcript even when token usage already exists', async () => {
    const transcriptPath = join(tmp, 'tools.jsonl');
    writeFileSync(transcriptPath, [
      { session_id: 'agent-session-tools' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'private command' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'private output' }] } },
    ].map(event => JSON.stringify(event)).join('\n'));
    const record = vi.fn(async () => ({ lastSequence: 1 }));
    const runner = new WorkflowRunner({} as ProviderBundle, {
      observer: { record } as unknown as RunObserver,
      agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
    });
    Object.defineProperty(runner, 'observationContext', { value: mockContext() });
    Object.defineProperty(runner, 'sandboxProviderName', { value: 'local' });
    Object.defineProperty(runner, 'agentProviderName', { value: 'claude-code' });
    await (runner as any).recordAgentTelemetry({ id: 'exec-tools', metadata: { provider: 'claude-code' }, telemetryPath: transcriptPath }, {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(record).toHaveBeenCalledWith(mockContext(), {
      kind: 'agent.session_recorded', sessionId: 'agent-session-tools',
      transcriptPath,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      tools: [{ id: 'call-1', name: 'Bash', result: 'failed' }],
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
  });
});
