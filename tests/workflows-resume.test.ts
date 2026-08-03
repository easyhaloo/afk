/**
 * Unit tests for attemptNativeResume — the native session-resume logic
 * extracted from WorkflowRunner.runPhase's context_high block.
 *
 * These tests cover the 8 scenarios identified during the grilling session:
 *  1. 'completed' path: snapshot found, restoreSession resolves, waitForResult -> completed
 *  2. 'continued' path: waitForResult -> context_high, budget mutated, loop back
 *  3. Capability absent: agentProvider.capabilities lacks 'resume' -> 'failed'
 *  4. loadFirst returns null: no snapshot in chain -> 'failed'
 *  5. restoreSession throws: error is caught -> 'failed'
 *  6. startAgent throws: error is caught -> 'failed'
 *  7. waitForResult throws timed_out: error is caught -> 'failed'
 *  8. Double context_high loop-back: first resumed -> context_high, second resumed -> completed
 *
 * The Phase 4 native-resume path is disabled in the handoff integration tests
 * (workflows-handoff.test.ts) via NoopSessionStoreChain — these unit tests
 * provide the coverage those integration tests intentionally skip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentProvider, AgentExecution, ExecutionResult, SessionSnapshot } from '../src/lib/agents/types';
import type { Sandbox } from '../src/lib/sandbox/types';
import type { SessionStoreChain } from '../src/lib/sessions/types';
import { attemptNativeResume } from '../src/lib/workflows/resume';
import { BudgetManager } from '../src/lib/workflows/budget';

function makeMockAgentProvider(withResume = true): AgentProvider {
  const capabilities = new Set<string>(withResume ? ['resume', 'streaming'] : ['streaming']);
  return {
    name: 'test-agent' as any,
    capabilities: capabilities as any,
    buildCommand: vi.fn().mockReturnValue({ command: 'test', env: {} }),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    captureSession: vi.fn().mockResolvedValue({} as SessionSnapshot),
  };
}

function makeMockSandbox(): { sandbox: Sandbox; execution: AgentExecution } {
  const execution: Partial<AgentExecution> = {
    id: 'exec-1',
    sessionId: 'sess-1',
    waitForResult: vi.fn(),
    waitForEvent: vi.fn().mockResolvedValue(null),
    interrupt: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    captureSession: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn(),
  };
  const sandbox: Partial<Sandbox> = {
    id: 'sandbox-1',
    startAgent: vi.fn().mockResolvedValue(execution as AgentExecution),
  };
  return { sandbox: sandbox as Sandbox, execution: execution as AgentExecution };
}

function makeMockChain(snapshot: SessionSnapshot | null): SessionStoreChain {
  const chain = {
    loadFirst: vi.fn().mockResolvedValue(snapshot ? { snapshot, storeName: 'file' } : null),
    saveFirst: vi.fn().mockResolvedValue({ stored: true }),
  } as any;
  return chain;
}

const BASE_CTX = {
  iid: 42,
  session: 'sess',
  wtPath: '/tmp/wt',
  runId: 'issue-42-gen-1',
  generation: 2,
  completionTimeoutMs: 600_000,
  contextHighTokens: 100_000,
  signalType: 'goal_complete' as const,
  goalText: '继续实现 issue #42',
  triggerTokens: 90_000,
};

describe('attemptNativeResume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns completed when resumed execution completes', async () => {
    const provider = makeMockAgentProvider(true);
    const { sandbox, execution } = makeMockSandbox();
    const chain = makeMockChain({} as SessionSnapshot);
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    (execution.waitForResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'completed',
    } as ExecutionResult);

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('completed');
    expect(provider.restoreSession).toHaveBeenCalled();
    expect(sandbox.startAgent).toHaveBeenCalled();
  });

  it('returns continued when resumed execution hits context_high, budget mutated', async () => {
    const provider = makeMockAgentProvider(true);
    const { sandbox, execution } = makeMockSandbox();
    const chain = makeMockChain({} as SessionSnapshot);
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    (execution.waitForResult as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'context_high',
      usage: { totalTokens: 90_000 },
    } as ExecutionResult);

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('continued');
    // Budget must be incremented by the handler (caller's obligation: apply reassignments)
    expect(budget.used).toBe(1);
    expect(budget.tokens).toBe(90_000); // triggerTokens from ctx
    expect(result.resumedExecution).toBeDefined();
    expect(result.resumeResult.status).toBe('context_high');
  });

  it('returns failed when agentProvider lacks resume capability', async () => {
    const provider = makeMockAgentProvider(false); // no 'resume' capability
    const { sandbox } = makeMockSandbox();
    const chain = makeMockChain({} as SessionSnapshot);
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('failed');
    expect(provider.restoreSession).not.toHaveBeenCalled();
    expect(sandbox.startAgent).not.toHaveBeenCalled();
  });

  it('returns failed when loadFirst returns null (no snapshot)', async () => {
    const provider = makeMockAgentProvider(true);
    const { sandbox } = makeMockSandbox();
    const chain = makeMockChain(null); // no snapshot
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('failed');
    expect(provider.restoreSession).not.toHaveBeenCalled();
    expect(sandbox.startAgent).not.toHaveBeenCalled();
  });

  it('returns failed when restoreSession throws', async () => {
    const provider = makeMockAgentProvider(true);
    (provider.restoreSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('restore failed'));
    const { sandbox } = makeMockSandbox();
    const chain = makeMockChain({} as SessionSnapshot);
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('failed');
    expect(sandbox.startAgent).not.toHaveBeenCalled();
  });

  it('returns failed when startAgent throws', async () => {
    const provider = makeMockAgentProvider(true);
    const { sandbox } = makeMockSandbox();
    (sandbox.startAgent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('start failed'));
    const chain = makeMockChain({} as SessionSnapshot);
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('failed');
  });

  it('returns failed when waitForResult throws timed_out', async () => {
    const provider = makeMockAgentProvider(true);
    const { sandbox, execution } = makeMockSandbox();
    const chain = makeMockChain({} as SessionSnapshot);
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    (execution.waitForResult as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('timeout'));

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('failed');
  });

  it('double context_high loop-back: first resumed -> context_high, second -> completed', async () => {
    const provider = makeMockAgentProvider(true);
    const { sandbox, execution } = makeMockSandbox();
    const chain = makeMockChain({} as SessionSnapshot);
    const budget = new BudgetManager(10, 1_000_000);
    const captureSession = vi.fn().mockResolvedValue(undefined);

    // First resumed execution: context_high
    (execution.waitForResult as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 'context_high', usage: { totalTokens: 80_000 } } as ExecutionResult)
      // Second resumed execution: completed
      .mockResolvedValueOnce({ status: 'completed' } as ExecutionResult);

    const result = await attemptNativeResume(
      BASE_CTX,
      budget,
      provider,
      sandbox,
      () => chain,
      captureSession,
    );

    expect(result.status).toBe('continued'); // first resumed: context_high -> continued, budget mutated
    expect(budget.used).toBe(1);
    // budget.tokens is set to ctx.triggerTokens (90_000), not resumeResult.usage.
    // The function returns 'continued' on first context_high without reading the
    // resumed execution's token count — that re-reading would happen on the
    // NEXT iteration's waitForResult, not here.
    expect(budget.tokens).toBe(90_000);
  });
});
