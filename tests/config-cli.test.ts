/**
 * CLI config merging — tests the actual merge logic in runWorkflowCli.
 *
 * Direct unit tests: mock at the module level, call runWorkflowCli with
 * partial opts and verify config defaults are applied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock factories (vi.hoisted so references are stable across resets) ─────────

const mockGetWorkflowConfig = vi.hoisted(() => vi.fn(() => ({
  agentDefault: 'claude',
  tmuxSession: 'afk',
  workflowHardTimeout: 7_200_000,
  completionTimeout: 7_200_000,
  contextThreshold: 100_000,
  promptTimeout: 30_000,
  handoffTimeout: 60_000,
  maxRetries: 2,
  goalBudget: 10_000_000,
  targetBranch: 'main',
  trackerTargetBranch: 'main',
  idleTimeout: 1_800_000,
  acCheckTimeout: 180_000,
  completionPoll: 5,
})));

const mockRun = vi.hoisted(() => vi.fn());

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../src/lib/core/config/manager', () => ({
  getWorkflowConfig: mockGetWorkflowConfig,
}));

vi.mock('../src/lib/workflows', () => ({
  WorkflowRunner: vi.fn(() => ({ run: mockRun })),
}));

vi.mock('../src/lib/client-factory', () => ({
  createTrackerClient: vi.fn(() => ({
    platform: 'github',
    projectId: 'test/repo',
  })),
}));

vi.mock('../src/lib/cli-utils', () => ({
  success: vi.fn(),
  detail: vi.fn(),
  warning: vi.fn(),
  handleCommandError: vi.fn(),
}));

// Prevent process.exit from terminating the test
vi.stubGlobal('process', {
  ...process,
  exit: vi.fn() as unknown as typeof process.exit,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runWorkflowCli config merging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ success: true, url: 'https://example.com/mr/1' });
    mockGetWorkflowConfig.mockReturnValue({
      agentDefault: 'claude',
      tmuxSession: 'afk',
      workflowHardTimeout: 7_200_000,
      completionTimeout: 7_200_000,
      contextThreshold: 100_000,
      promptTimeout: 30_000,
      handoffTimeout: 60_000,
      maxRetries: 2,
      goalBudget: 10_000_000,
      targetBranch: 'main',
      trackerTargetBranch: 'main',
      idleTimeout: 1_800_000,
      acCheckTimeout: 180_000,
      completionPoll: 5,
    });
  });

  it('applies config defaults when no optional flags provided', async () => {
    const { runWorkflowCli } = await import('../src/lib/workflows/run-cmd');
    await runWorkflowCli({ iid: 42 });

    expect(mockRun).toHaveBeenCalledTimes(1);
    const runOpts = mockRun.mock.calls[0][0];
    expect(runOpts.maxRetries).toBe(2);
    expect(runOpts.hardTimeoutMs).toBe(7_200_000);
    expect(runOpts.maxHandoffs).toBe(10);             // ceil(10M/1M)
    expect(runOpts.contextHighTokens).toBe(100_000);
    expect(runOpts.maxTotalTokens).toBe(10_000_000);
  });

  it('user-provided flags override config defaults', async () => {
    const { runWorkflowCli } = await import('../src/lib/workflows/run-cmd');
    await runWorkflowCli({
      iid: 42,
      maxRetries: 5,
      hardTimeoutMs: 3_600_000,
      contextHighTokens: 80_000,
      maxTotalTokens: 2_000_000,
    });

    const runOpts = mockRun.mock.calls[0][0];
    expect(runOpts.maxRetries).toBe(5);
    expect(runOpts.hardTimeoutMs).toBe(3_600_000);
    expect(runOpts.contextHighTokens).toBe(80_000);
    expect(runOpts.maxTotalTokens).toBe(2_000_000);
  });

  it('partial override: provided flags merged with config defaults for the rest', async () => {
    const { runWorkflowCli } = await import('../src/lib/workflows/run-cmd');
    await runWorkflowCli({ iid: 42, contextHighTokens: 150_000 });

    const runOpts = mockRun.mock.calls[0][0];
    expect(runOpts.contextHighTokens).toBe(150_000); // override
    expect(runOpts.maxRetries).toBe(2);             // from config
    expect(runOpts.hardTimeoutMs).toBe(7_200_000); // from config
    expect(runOpts.maxTotalTokens).toBe(10_000_000); // from config
  });
});
