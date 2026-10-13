import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import { WorkflowRunner } from '../workflow-engine.js';
import type { RunObserver } from '../../observability/run-observer.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Re-export findCodexRollout for mocking — imported from agent-telemetry.ts
// so tests can spy on the module.
vi.mock('../../infrastructure/observability/agent-telemetry.js', async () => {
  const actual = await vi.importActual('../../infrastructure/observability/agent-telemetry.js');
  return {
    ...actual as object,
    findCodexRollout: vi.fn(actual!.findCodexRollout),
  };
});

/**
 * Tests for agent.session_recorded wiring in WorkflowRunner.
 *
 * Verifies:
 * 1. result.usage is used directly (no file read needed)
 * 2. Falls back to transcript file when result.usage is absent
 * 3. Container sandbox returns early without emitting
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
    process.env.HOME = tmp;
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.HOME;
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
      telemetryPath: join(tmp, 'nonexistent-transcript.jsonl'), // does not exist
    } as any;

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
    expect(data.usage).toEqual({ inputTokens: 5000, outputTokens: 200, totalTokens: 5200 });
  });

  it('falls back to transcript file when result.usage is absent (interactive path)', async () => {
    // Interactive/tmux: no stdout stream, result.usage is undefined.
    // recordAgentTelemetry must read the transcript file.
    const transcriptPath = join(tmp, 'transcript.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'cost-state',
      totalCostUSD: 1.5,
      modelUsage: {
        'm': { inputTokens: 1000, outputTokens: 50, thinkingTokens: 0, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
      },
    }) + '\n');

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
    expect(data.usage?.inputTokens).toBe(1015); // 1000 + 10 + 5
    expect(data.usage?.outputTokens).toBe(50);
  });

  it('reaches codex branch when telemetryPath is absent but threadId is present', async () => {
    // The exec transport has no sessionId, so telemetryPath is undefined.
    // With threadId present in metadata, findCodexRollout must still be called.
    const findCodexRollout = await import('../../infrastructure/observability/agent-telemetry.js').then(m => m.findCodexRollout);
    vi.mocked(findCodexRollout).mockResolvedValueOnce('/fake/rollout.jsonl');

    const record = vi.fn(async () => ({ lastSequence: 1 }));
    const observer = { record } as unknown as RunObserver;
    const claim = vi.fn(async () => null);

    const runner = new WorkflowRunner(
      { backlog: { claim } } as unknown as ProviderBundle,
      {
        observer,
        agentProvider: { name: 'codex', capabilities: new Set() } as never,
      },
    );

    Object.defineProperty(runner, 'observationContext', { value: mockContext(), writable: true, configurable: true });
    Object.defineProperty(runner, 'sandboxProviderName', { value: 'local', writable: true, configurable: true });
    Object.defineProperty(runner, 'agentProviderName', { value: 'codex', writable: true, configurable: true });

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

    await (runner as any).recordAgentTelemetry(execution, result);

    expect(findCodexRollout).toHaveBeenCalledTimes(1);
    expect(findCodexRollout).toHaveBeenCalledWith('thread-abc123');
  });

  it('returns early for container sandbox without emitting any event', async () => {
    // Container: HOME not forwarded, harness dirs not mounted.
    // recordAgentTelemetry must not emit any event.
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
    Object.defineProperty(runner, 'sandboxProviderName', { value: 'docker', writable: true, configurable: true });
    Object.defineProperty(runner, 'agentProviderName', { value: 'claude-code', writable: true, configurable: true });

    const execution = {
      id: 'exec-3',
      sessionId: 'session-docker',
      metadata: { provider: 'claude-code', transport: 'process' as const },
      telemetryPath: '/nonsense/path/transcript.jsonl',
    } as any;

    const result = {
      version: 1 as const,
      runId: 'exec-3',
      status: 'completed' as const,
      provider: 'container',
      sessionId: 'session-docker',
      commits: [] as string[],
    };

    await (runner as any).recordAgentTelemetry(execution, result);

    expect(record).not.toHaveBeenCalled();
  });
});
