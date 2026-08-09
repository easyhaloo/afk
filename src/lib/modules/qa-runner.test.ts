import { describe, expect, it, vi } from 'vitest';
import { QARunner } from './qa-runner';

const ioMocks = vi.hoisted(() => ({ configureStatusline: vi.fn(async () => {}) }));
vi.mock('../io', async importOriginal => ({
  ...await importOriginal<typeof import('../io')>(),
  configureStatusline: ioMocks.configureStatusline,
}));

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
    getActiveRework: vi.fn(async () => undefined),
    createRework: vi.fn(async () => ({ id: 'r1', attempt: 1 })),
    resolveRework: vi.fn(async () => {}),
  };
  const changes = {
    findForBacklog: vi.fn(async () => null),
    create: vi.fn(async ({ sourceBranch, targetBranch }: any) => ({ id: 'pr-60', sourceBranch, targetBranch, url: 'https://example.test/pr/60' })),
    merge: vi.fn(async () => {}),
  };
  const branches = {
    createVerificationWorktree: vi.fn(async () => ({ branchName: 'qa-60', worktreePath: process.cwd() })),
    commit: vi.fn(async () => 'commit-60'),
    push: vi.fn(async () => {}),
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
      structuredOutput: { type: 'goal_complete', kind: 'qa', result: 'PASS', summary: 'all integration checks passed' },
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
  return { providers: { backlog, changes, branches } as any, changes, branches, sandboxProvider: sandboxProvider as any, agentProvider: agentProvider as any, sandbox, execution };
}

describe('QARunner execution boundary', () => {
  it('runs batch QA through SandboxProvider without tmux readiness calls', async () => {
    const f = fixture();
    f.changes.findForBacklog.mockResolvedValue({ id: 'pr-60', url: 'https://example.test/pr/60' });
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
    const qaPrompt = f.sandbox.startAgent.mock.calls[0][0].prompt;
    expect(qaPrompt).toContain('Backlog title: search mode');
    expect(qaPrompt).toContain('Backlog description:\nsupport /s');
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.waitForPrompt).not.toHaveBeenCalled();
    expect(tmux.sendPrompt).not.toHaveBeenCalled();
    expect(tmux.waitForSignal).not.toHaveBeenCalled();
  });

  it('passes tmux only to the sandbox for interactive QA', async () => {
    const f = fixture();
    f.changes.findForBacklog.mockResolvedValue({ id: 'pr-60', url: 'https://example.test/pr/60' });
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

  it('configures the interactive statusline after merging the QA worktree', async () => {
    const f = fixture();
    const mergeBranch = vi.fn(async () => {});
    ioMocks.configureStatusline.mockClear();
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, executionMode: 'interactive',
      tmux: {} as any, mergeBranch,
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });

    expect(mergeBranch).toHaveBeenCalled();
    expect(ioMocks.configureStatusline).toHaveBeenCalledWith(process.cwd());
    expect(mergeBranch.mock.invocationCallOrder[0]).toBeLessThan(ioMocks.configureStatusline.mock.invocationCallOrder[0]);
  });

  it('publishes an independent QA runtime record through completion', async () => {
    const f = fixture();
    f.changes.findForBacklog.mockResolvedValue({ id: 'pr-60', url: 'https://example.test/pr/60' });
    const runtime = {
      start: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
      writeDiagnostics: vi.fn(async () => '/tmp/diagnostics'),
      appendActivity: vi.fn(async () => ({})),
    };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
      runtimeManager: runtime as any,
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backlogId: '60', phase: 'verifying', executionMode: 'batch', status: 'running',
    }));
    expect(runtime.heartbeat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ worktree: process.cwd() }));
    expect(runtime.writeDiagnostics).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      result: expect.objectContaining({ status: 'completed' }), output: expect.any(String),
    }));
    expect(runtime.appendActivity).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'qa' }));
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));
  });

  it('persists a diagnosable QA failure as an AFK rework record', async () => {
    const f = fixture();
    f.execution.waitForResult.mockResolvedValue({
      version: 1,
      runId: 'execution-60',
      status: 'completed',
      provider: 'batch',
      structuredOutput: {
        type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: 'search shortcut failed',
        failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
      },
      commits: [],
    });
    const runtime = { start: vi.fn(async () => {}), heartbeat: vi.fn(async () => ({})), finish: vi.fn(async () => ({})), writeDiagnostics: vi.fn(async () => '/tmp/diagnostics') };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
      runtimeManager: runtime as any,
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: false });
    expect(f.providers.backlog.createRework).toHaveBeenCalledWith('60', expect.objectContaining({
      source: 'qa', summary: 'search shortcut failed',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
    }));
    expect(f.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'blocked', expect.anything());
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'blocked', errorSummary: expect.stringContaining('search shortcut failed'),
    }));
  });

  it('resolves the active QA rework record only after QA passes', async () => {
    const f = fixture();
    f.providers.backlog.getActiveRework.mockResolvedValue({ id: 'r1', summary: 'search shortcut failed' });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, executionMode: 'batch', mergeBranch: vi.fn(async () => {}),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.providers.backlog.resolveRework).toHaveBeenCalledWith('60', 'r1', expect.objectContaining({ summary: expect.stringContaining('QA passed') }));
  });

  it('commits and creates a mergeable change after QA on the root backlog without merging', async () => {
    const f = fixture();
    const root = { ...(await f.providers.backlog.get('60')), parentId: undefined };
    f.providers.backlog.get.mockResolvedValue(root);
    const mergeBranch = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch,
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: true, autoMerged: false });
    expect(mergeBranch).toHaveBeenCalledWith(process.cwd(), 'main', 'afk/backlog-60');
    expect(f.providers.branches.commit).toHaveBeenCalledWith(process.cwd(), expect.stringContaining('QA'));
    expect(f.providers.branches.push).toHaveBeenCalledWith('qa-60', process.cwd());
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({
      sourceBranch: 'qa-60', targetBranch: 'main', draft: false,
    }));
    expect(f.providers.changes.merge).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
  });

  it('targets and auto-merges a child backlog into its parent branch', async () => {
    const f = fixture();
    const child = { ...(await f.providers.backlog.get('60')), parentId: '10' };
    const parent = { ...child, id: '10', title: 'parent', parentId: undefined, branchName: 'afk/backlog-10' };
    f.providers.backlog.get.mockImplementation(async (id: string) => id === '10' ? parent : child);
    f.changes.findForBacklog.mockResolvedValue({ id: 'pr-60', url: 'https://example.test/pr/60' });
    const mergeBranch = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch,
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: true, autoMerged: true });
    expect(mergeBranch).toHaveBeenCalledWith(process.cwd(), 'afk/backlog-10', 'afk/backlog-60');
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({ targetBranch: 'afk/backlog-10' }));
    expect(f.providers.changes.merge).toHaveBeenCalledWith('pr-60');
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'done', expect.anything());
  });
});
