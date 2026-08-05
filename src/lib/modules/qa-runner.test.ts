import { describe, expect, it, vi } from 'vitest';
import { QARunner } from './qa-runner';

const config = {
  targetBranch: 'main',
  completionTimeout: 1000,
  contextThreshold: 100_000,
} as any;

function fixture() {
  const item = {
    id: '60',
    title: 'search mode',
    description: 'support /s',
    dependsOn: [],
    state: 'verification',
    executionMode: 'afk',
    tags: [],
    branchName: 'afk/backlog-60',
    providerRef: '60',
  };
  const backlog = {
    get: vi.fn(async () => ({ ...item })),
    transition: vi.fn(async () => {}),
    setExecutionMode: vi.fn(async () => {}),
  };
  const changes = {
    findForBacklog: vi.fn(async () => ({ id: 'pr-60', url: 'https://example.test/pr/60' })),
    merge: vi.fn(async () => {}),
  };
  const branches = {
    createVerificationWorktree: vi.fn(async () => ({ branchName: 'qa-60', worktreePath: process.cwd() })),
    cleanup: vi.fn(async () => {}),
  };
  const execution = {
    id: 'execution-60',
    waitForEvent: vi.fn(async () => null),
    waitForResult: vi.fn(async () => ({
      version: 1,
      runId: 'execution-60',
      status: 'completed',
      provider: 'batch',
      structuredOutput: { type: 'goal_complete', kind: 'qa', result: 'PASS' },
      commits: [],
    })),
    interrupt: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    captureOutput: vi.fn(async () => ''),
    captureSession: vi.fn(async () => undefined),
    resume: vi.fn(),
  };
  const sandbox = {
    id: 'sandbox-60',
    worktreePath: process.cwd(),
    workspacePath: process.cwd(),
    startAgent: vi.fn(async () => execution),
    close: vi.fn(async () => {}),
  };
  const sandboxProvider = { create: vi.fn(async () => sandbox) };
  const agentProvider = {
    name: 'claude-code',
    capabilities: new Set(['streaming', 'structured-output']),
    buildCommand: vi.fn(() => ({ argv: ['claude', '--print'], cwd: process.cwd() })),
  };
  return { providers: { backlog, changes, branches } as any, sandboxProvider: sandboxProvider as any, agentProvider: agentProvider as any, sandbox, execution };
}

describe('QARunner execution boundary', () => {
  it('runs batch QA through SandboxProvider without tmux readiness calls', async () => {
    const f = fixture();
    const tmux = { createSession: vi.fn(), waitForPrompt: vi.fn(), sendPrompt: vi.fn(), waitForSignal: vi.fn() };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      tmux: tmux as any,
      mergeBranch: vi.fn(async () => {}),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch' }));
    expect(f.sandboxProvider.create.mock.calls[0][0].tmux).toBeUndefined();
    expect(f.agentProvider.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch' }));
    expect(f.sandbox.startAgent).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: 'batch',
      signalType: 'goal_complete',
      agentProvider: f.agentProvider,
      prompt: expect.stringContaining('"kind":"qa"'),
    }));
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.waitForPrompt).not.toHaveBeenCalled();
    expect(tmux.sendPrompt).not.toHaveBeenCalled();
    expect(tmux.waitForSignal).not.toHaveBeenCalled();
  });

  it('passes tmux only to the sandbox for interactive QA', async () => {
    const f = fixture();
    const tmux = {};
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'interactive',
      tmux: tmux as any,
      mergeBranch: vi.fn(async () => {}),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.sandboxProvider.create.mock.calls[0][0]).toMatchObject({ executionMode: 'interactive', tmux });
  });
});
