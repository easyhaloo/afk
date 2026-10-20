import { describe, expect, it, vi } from 'vitest';
import { QARunner } from './qa-runner.js';
import { createAgentProvider, registerAgentProvider } from '../../domain/agents/index.js';
import { TrackerBacklogProvider } from '@afk/infrastructure';
import { parseReworkRecord } from '@afk/application';
import type { TrackedIssue, TrackerProvider } from '@afk/application';
import type { ChangeRequest } from '@afk/infrastructure';
import type { AgentCapability, AgentExecutionMetadata, ExecutionResult } from '../../domain/agents/types.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetStore } from '../workflows/budget-store.js';
import { getLogContext, withLogContext } from '@afk/infrastructure';

const ioMocks = vi.hoisted(() => ({ configureStatusline: vi.fn(async () => {}) }));
vi.mock('@afk/infrastructure', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/infrastructure')>(),
  configureStatusline: ioMocks.configureStatusline,
}));

const config = {
  targetBranch: 'main',
  completionTimeout: 1000,
  qaTimeout: 2000,
  contextThreshold: 100_000,
  maxQaReworkAttempts: 3,
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
    findForBacklog: vi.fn(async (): Promise<ChangeRequest | null> => null),
    create: vi.fn(async ({ sourceBranch, targetBranch }: { sourceBranch: string; targetBranch: string }): Promise<ChangeRequest> => ({
      id: 'pr-60', state: 'open', sourceBranch, targetBranch, url: 'https://example.test/pr/60',
    })),
    merge: vi.fn(async () => {}),
  };
  const branches = {
    createVerificationWorktree: vi.fn(async () => ({ branchName: 'qa-60', worktreePath: process.cwd() })),
    commit: vi.fn(async () => 'commit-60'),
    push: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
  const executionMetadata: AgentExecutionMetadata = { provider: 'claude-code', transport: 'process' };
  let telemetryPath: string | undefined;
  const execution = {
    id: 'execution-60',
    metadata: executionMetadata,
    telemetryPath,
    waitForEvent: vi.fn(async () => null),
    waitForResult: vi.fn(async (): Promise<ExecutionResult> => ({
      version: 1,
      runId: 'execution-60',
      status: 'completed',
      provider: 'claude-code',
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
    createExecution: vi.fn(async () => execution),
  };
  return { providers: { backlog, changes, branches } as any, changes, branches, sandboxProvider: sandboxProvider as any, agentProvider: agentProvider as any, sandbox, execution };
}

function persistentReworkFixture(platform: 'github' | 'gitlab', maxQaReworkAttempts = 3) {
  const issue: TrackedIssue = { id: 60, platform, title: 'search mode', description: 'support /s', labels: ['stage::qa', 'mode::afk'], state: 'opened', projectId: 'org/repo', url: '' };
  const comments: Array<{ id: string; body: string }> = [];
  const tracker: TrackerProvider = {
    platform, projectId: 'org/repo',
    getIssue: vi.fn(async () => ({ ...issue, labels: [...issue.labels] })),
    listIssues: vi.fn(async () => [issue]),
    listMRs: vi.fn(async () => []),
    updateLabels: vi.fn(async (_id, delta) => {
      issue.labels = [...issue.labels.filter(label => !delta.remove.includes(label)), ...delta.add];
    }),
    listIssueComments: vi.fn(async () => comments.map(comment => ({ ...comment }))),
    addComment: vi.fn(async (_id, body) => { comments.push({ id: `comment-${comments.length + 1}`, body }); }),
    updateIssueComment: vi.fn(async (_id, commentId, body) => {
      comments.find(comment => comment.id === commentId)!.body = body;
    }),
    // The rest of the tracker port is not reachable from the rework path.
    createIssue: vi.fn(async () => 0),
    updateIssue: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    linkIssues: vi.fn(async () => {}),
    getMR: vi.fn(async () => ({ id: 0, platform, title: '', state: 'opened' as const, sourceBranch: '', targetBranch: '', url: '', projectId: 'org/repo' })),
    isMRLinkedToIssue: vi.fn(async () => false),
    createMR: vi.fn(async () => 0),
    mergeMR: vi.fn(async () => {}),
    approveMR: vi.fn(async () => {}),
    closeMR: vi.fn(async () => {}),
    reopenMR: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    getBranches: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getRecentCommits: vi.fn(async () => []),
    parseAC: vi.fn(() => ({ items: [], source: 'none' as const })),
    getRetryCount: vi.fn(() => 0),
    detectTargetBranch: vi.fn(async () => 'main'),
    uploadArtifacts: vi.fn(async () => ''),
  };
  const createRunner = () => {
    const f = fixture();
    const backlog = new TrackerBacklogProvider(tracker, { atomicClaim: vi.fn() });
    const transition = vi.spyOn(backlog, 'transition');
    const setExecutionMode = vi.spyOn(backlog, 'setExecutionMode');
    const createRework = vi.spyOn(backlog, 'createRework');
    f.execution.waitForResult.mockResolvedValue({
      version: 1, runId: 'execution-60', status: 'completed', provider: 'claude-code', commits: [],
      structuredOutput: {
        type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: 'search shortcut failed',
        failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
      },
    });
    const runner = new QARunner({ ...f.providers, backlog }, { ...config, maxQaReworkAttempts }, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider,
      executionMode: 'batch', mergeBranch: vi.fn(async () => {}),
      runtimeManager: {
        start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity: vi.fn(),
      } as any,
    });
    return { runner, backlog, transition, setExecutionMode, createRework };
  };
  return { comments, createRunner };
}

describe('QARunner execution boundary', () => {
  it('resolves the configured agent provider when none is injected', () => {
    const original = createAgentProvider('codex');
    const codex = {
      name: 'codex' as const,
      capabilities: new Set<AgentCapability>(),
      createExecution: vi.fn(),
    };
    registerAgentProvider(codex);

    try {
      const runner = new QARunner(fixture().providers, { ...config, agentDefault: 'codex' });
      expect((runner as any).agentProvider).toBe(codex);
    } finally {
      registerAgentProvider(original);
    }
  });

  it('runs batch QA through SandboxProvider without tmux readiness calls', async () => {
    const f = fixture();
    f.changes.findForBacklog.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main', url: 'https://example.test/pr/60',
    });
    const tmux = { createSession: vi.fn(), waitForPrompt: vi.fn(), sendPrompt: vi.fn(), waitForSignal: vi.fn() };
    const runtime = {
      kind: 'codex',
      transport: 'exec',
      auth: 'chatgpt',
      provider: 'openai',
      startupTimeoutMs: 5_000,
    } as const;
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      agentRuntime: runtime,
      executionMode: 'batch',
      tmux: tmux as any,
      mergeBranch: vi.fn(async () => {}),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.execution.waitForResult).toHaveBeenCalledWith({ completionTimeoutMs: 2000 });
    expect(f.sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch' }));
    expect(f.sandboxProvider.create.mock.calls[0][0].tmux).toBeUndefined();
    const session = f.sandboxProvider.create.mock.calls[0][0].session;
    expect(f.agentProvider.createExecution).toHaveBeenCalledWith({
      sandbox: f.sandbox,
      worktreePath: process.cwd(),
      sessionId: session,
      executionMode: 'batch',
      signalType: 'goal_complete',
      prompt: expect.stringContaining('"kind":"qa"'),
      generation: 1,
      runtime,
    });
    expect(f.sandbox.startAgent).not.toHaveBeenCalled();
    const qaPrompt = f.agentProvider.createExecution.mock.calls[0][0].prompt;
    expect(qaPrompt).toContain('不要把 commit、push 或创建 MR 作为本次 Agent 的失败条件');
    expect(qaPrompt).toContain('Backlog title: search mode');
    expect(qaPrompt).toContain('Backlog description:\nsupport /s');
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.waitForPrompt).not.toHaveBeenCalled();
    expect(tmux.sendPrompt).not.toHaveBeenCalled();
    expect(tmux.waitForSignal).not.toHaveBeenCalled();
  });

  it('classifies a QA execution timeout separately from a generic QA failure', async () => {
    const f = fixture();
    f.execution.waitForResult.mockResolvedValue({
      version: 1,
      runId: 'execution-60',
      status: 'timed_out',
      provider: 'claude-code',
      sessionId: 'agent-session-60',
      commits: [],
    });
    const runner = new QARunner(f.providers, { ...config, qaTimeout: 25 }, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
    });

    await expect(runner.process('60')).resolves.toMatchObject({
      success: false,
      failureCode: 'qa_timeout',
    });
    expect(f.execution.waitForResult).toHaveBeenCalledWith({ completionTimeoutMs: 25 });
  });

  it('passes tmux only to the sandbox for interactive QA', async () => {
    const f = fixture();
    f.changes.findForBacklog.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main', url: 'https://example.test/pr/60',
    });
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
    f.agentProvider.name = 'codex';
    f.execution.metadata = {
      provider: 'codex', transport: 'app-server', auth: 'chatgpt', modelProvider: 'openai',
      endpointKind: 'stdio', threadId: 'thread-60',
    };
    f.changes.findForBacklog.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main', url: 'https://example.test/pr/60',
    });
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
      agentRuntime: {
        kind: 'codex', transport: 'app-server', auth: 'chatgpt', provider: 'openai',
        endpoint: 'stdio://', startupTimeoutMs: 5_000,
      },
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backlogId: '60', workspace: process.cwd(), providerRef: '60',
      phase: 'verifying', executionMode: 'batch', status: 'running',
      agentProvider: 'codex', agentTransport: 'app-server', agentAuth: 'chatgpt', agentModelProvider: 'openai',
    }));
    expect(runtime.heartbeat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      agentTransport: 'app-server', agentThreadId: 'thread-60',
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
      provider: 'claude-code',
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

    await expect(runner.process('60')).resolves.toMatchObject({
      success: false, rework: true, summary: 'search shortcut failed',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
    });
    expect(f.providers.backlog.createRework).toHaveBeenCalledWith('60', expect.objectContaining({
      source: 'qa', summary: 'search shortcut failed',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
    }));
    expect(f.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'blocked', expect.anything());
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'blocked', errorSummary: expect.stringContaining('search shortcut failed'),
    }));
  });

  it.each(['github', 'gitlab'] as const)('bounds repeated active QA FAIL using persisted %s comments across runners', async platform => {
    const f = persistentReworkFixture(platform);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = f.createRunner();
      const result = await current.runner.process('60');
      expect(result.success).toBe(false);
      expect(result.summary).toContain('search shortcut failed');
      expect(result.failedCriteria).toEqual([{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }]);
      await expect(current.backlog.getActiveRework('60')).resolves.toMatchObject({ id: `r${attempt}`, attempt, status: 'open' });
      expect(f.comments.map(comment => parseReworkRecord(comment)?.record.status)).toEqual([
        ...Array(attempt - 1).fill('superseded'), 'open',
      ]);
      if (attempt < 3) {
        expect(result.rework).toBe(true);
        await expect(current.backlog.get('60')).resolves.toMatchObject({ state: 'rework', executionMode: 'afk' });
      } else {
        expect(result.rework).not.toBe(true);
        expect(result.summary).toContain('3/3');
        await expect(current.backlog.get('60')).resolves.toMatchObject({ state: 'blocked', executionMode: 'hitl' });
        expect(await current.backlog.isRunnable(await current.backlog.get('60'))).toBe(false);
        expect(current.transition).not.toHaveBeenCalledWith('60', 'rework', expect.anything());
        expect(current.transition).not.toHaveBeenCalledWith('60', 'rework');
        expect(current.setExecutionMode).not.toHaveBeenCalledWith('60', 'afk');
      }
    }
    const subsequent = f.createRunner();
    const subsequentResult = await subsequent.runner.process('60');
    expect(subsequentResult).toMatchObject({ success: false });
    expect(subsequentResult.rework).not.toBe(true);
    await expect(subsequent.backlog.get('60')).resolves.toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    expect(subsequent.createRework).not.toHaveBeenCalled();
    expect(subsequent.transition).not.toHaveBeenCalledWith('60', 'rework', expect.anything());
    expect(subsequent.transition).not.toHaveBeenCalledWith('60', 'rework');
    expect(subsequent.setExecutionMode).not.toHaveBeenCalledWith('60', 'afk');
    expect(f.comments).toHaveLength(3);
  });

  it.each([1, 4])('honors a configured QA failure limit of %s', async limit => {
    const f = persistentReworkFixture('github', limit);
    for (let attempt = 1; attempt <= limit; attempt++) {
      const current = f.createRunner();
      const result = await current.runner.process('60');
      expect(result.rework === true).toBe(attempt < limit);
      await expect(current.backlog.getActiveRework('60')).resolves.toMatchObject({ attempt });
      await expect(current.backlog.get('60')).resolves.toMatchObject({
        state: attempt < limit ? 'rework' : 'blocked', executionMode: attempt < limit ? 'afk' : 'hitl',
      });
      if (attempt === limit) {
        expect(current.transition).not.toHaveBeenCalledWith('60', 'rework');
        expect(current.setExecutionMode).not.toHaveBeenCalledWith('60', 'afk');
      }
    }
  });

  it('returns a diagnostic summary when the QA agent fails to start', async () => {
    const f = fixture();
    f.agentProvider.createExecution.mockRejectedValueOnce(new Error('provider unavailable'));
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
    });

    await expect(runner.process('60')).resolves.toMatchObject({
      success: false,
      summary: 'QA execution failed: provider unavailable',
    });
  });

  it.each(['backlog', 'execution base'])('routes a failed %s lookup to blocked with a diagnostic summary', async lookup => {
    const f = fixture();
    if (lookup === 'execution base') {
      f.providers.backlog.get.mockResolvedValueOnce({ ...await f.providers.backlog.get('60'), baseBacklogId: '11' });
    }
    f.providers.backlog.get.mockRejectedValueOnce(new Error('provider read unavailable'));
    const runner = new QARunner(f.providers, config, { sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider });

    await expect(runner.process('60')).resolves.toMatchObject({ success: false, summary: 'QA execution failed: provider read unavailable' });
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'blocked', { reason: 'QA execution failed: provider read unavailable' });
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
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

  it('passes the local QA commit SHA to the audit hook', async () => {
    const f = fixture();
    const onCommit = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
      onCommit,
    });

    await runner.process('60');

    expect(onCommit).toHaveBeenCalledWith('commit-60', 'qa-60');
  });

  it('keeps the managed execution log context throughout QA', async () => {
    const f = fixture();
    const context = { runId: 'managed-attempt', workItemId: 'github:org/repo#60' };
    const onCommit = vi.fn(async () => { expect(getLogContext()).toEqual(context); });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}), onCommit,
    });
    await withLogContext(context, () => runner.process('60'));
    expect(onCommit).toHaveBeenCalledOnce();
    expect(f.sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({ runtimeRunId: context.runId }));
    expect(getLogContext()).toBeUndefined();
  });

  it('does not call the audit hook when the branch provider reports no commit', async () => {
    const f = fixture();
    f.branches.commit.mockResolvedValue(undefined as never);
    const onCommit = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
      onCommit,
    });

    await runner.process('60');

    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(['tokens', 'handoffs', 'corrupt'] as const)('blocks QA before starting an agent for a %s budget ledger', async condition => {
    const root = await mkdtemp(join(tmpdir(), 'afk-qa-budget-'));
    try {
      const store = new BudgetStore(root, '60');
      await store.save({ used: condition === 'handoffs' ? 1 : 0, tokens: 100, sessions: { session: 100 } });
      if (condition === 'corrupt') await writeFile(join(root, '.afk', 'budgets', '60.json'), '{}');
      const f = fixture();
      const runner = new QARunner(f.providers, { ...config, goalBudget: condition === 'tokens' ? 100 : 1000 }, {
        sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, projectRoot: root,
        executionMode: 'batch', mergeBranch: vi.fn(async () => {}),
      });
      const result = await runner.process('60');
      expect(result).toMatchObject({ success: false, summary: expect.stringContaining(condition === 'corrupt' ? 'corrupt' : 'budget exhausted') });
      expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(f.providers.branches.createVerificationWorktree).not.toHaveBeenCalled();
      expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['local', 'docker', 'podman'])('records QA native usage in %s without counting a repeated session twice', async sandboxName => {
    const root = await mkdtemp(join(tmpdir(), 'afk-qa-usage-'));
    const previousHome = process.env.HOME;
    try {
      const f = fixture();
      f.sandboxProvider.name = sandboxName;
      const nativeSessionId = 'f1817331-17b7-40e2-98f0-834f6b02320c';
      f.execution.telemetryPath = join(root, 'qa-204-1791984447541.jsonl');
      f.execution.metadata.threadId = nativeSessionId;
      await writeFile(join(root, `${nativeSessionId}.jsonl`), JSON.stringify({ session_id: nativeSessionId }) + '\n');
      process.env.HOME = root;
      const result = await f.execution.waitForResult();
      const tools = [{ id: 'qa-tool', name: 'Bash', result: 'failed', exitCode: 1 }];
      f.execution.waitForResult.mockResolvedValue({ ...result, sessionId: 'qa-204-1791984447541', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, tools } as never);
      const onSession = vi.fn(async () => {});
      for (let attempt = 0; attempt < 2; attempt++) {
        const runner = new QARunner(f.providers, { ...config, goalBudget: 1000 }, {
          sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, projectRoot: root,
          executionMode: 'batch', mergeBranch: vi.fn(async () => {}), onSession,
        });
        expect(await runner.process('60')).toMatchObject({ success: true });
      }
      expect(await new BudgetStore(root, '60').load()).toMatchObject({ used: 0, tokens: 15, sessions: { [nativeSessionId]: 15 } });
      expect(onSession).toHaveBeenCalledWith({
        kind: 'agent.session_recorded', sessionId: nativeSessionId,
        ...(sandboxName === 'local' ? { transcriptPath: join(root, `${nativeSessionId}.jsonl`) } : {}),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, tools,
      });
    } finally {
      process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not publish when the attempt audit refuses publication', async () => {
    const fixtureData = fixture();
    const beforeChange = vi.fn(async () => { throw new Error('audit unavailable'); });
    const runner = new QARunner(fixtureData.providers, config, {
      sandboxProvider: fixtureData.sandboxProvider, agentProvider: fixtureData.agentProvider,
      executionMode: 'batch', mergeBranch: vi.fn(async () => {}), beforeChange,
    });
    expect(await runner.process('60')).toMatchObject({ success: false });
    expect(beforeChange).toHaveBeenCalledWith('publish', expect.objectContaining({ id: '60' }));
    expect(fixtureData.changes.create).not.toHaveBeenCalled();
    expect(fixtureData.changes.merge).not.toHaveBeenCalled();
  });

  it('does not merge a child when the attempt audit refuses merge', async () => {
    const fixtureData = fixture();
    fixtureData.providers.backlog.get.mockResolvedValue({ ...await fixtureData.providers.backlog.get('60'), parentId: '11' });
    const beforeChange = vi.fn(async (action: string) => {
      if (action === 'merge') throw new Error('audit unavailable');
    });
    const runner = new QARunner(fixtureData.providers, config, {
      sandboxProvider: fixtureData.sandboxProvider, agentProvider: fixtureData.agentProvider,
      executionMode: 'batch', mergeBranch: vi.fn(async () => {}), beforeChange,
    });
    expect(await runner.process('60')).toMatchObject({ success: false });
    expect(beforeChange).toHaveBeenCalledWith('merge', expect.objectContaining({ id: '60' }), expect.objectContaining({ id: 'pr-60' }));
    expect(fixtureData.changes.merge).not.toHaveBeenCalled();
  });

  it('reuses a matching open change instead of creating a duplicate for an audited attempt', async () => {
    const fixtureData = fixture();
    fixtureData.changes.findForBacklog.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main', url: 'https://example.test/pr/60',
    });
    const afterPublication = vi.fn(async () => {});
    const runner = new QARunner(fixtureData.providers, config, {
      sandboxProvider: fixtureData.sandboxProvider, agentProvider: fixtureData.agentProvider,
      executionMode: 'batch', mergeBranch: vi.fn(async () => {}),
      beforeChange: vi.fn(async () => {}), afterPublication,
    });
    expect(await runner.process('60')).toMatchObject({ success: true, autoMerged: false, mrUrl: 'https://example.test/pr/60' });
    expect(fixtureData.changes.create).not.toHaveBeenCalled();
    expect(afterPublication).toHaveBeenCalledWith(expect.objectContaining({ id: 'pr-60' }));
  });

  it('targets and auto-merges an organizational child backlog into the configured target branch', async () => {
    const f = fixture();
    const child = { ...(await f.providers.backlog.get('60')), parentId: '10' };
    f.providers.backlog.get.mockResolvedValue(child);
    f.changes.findForBacklog.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main', url: 'https://example.test/pr/60',
    });
    const mergeBranch = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch,
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: true, autoMerged: true });
    expect(mergeBranch).toHaveBeenCalledWith(process.cwd(), 'main', 'afk/backlog-60');
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({ targetBranch: 'main' }));
    expect(f.providers.changes.merge).toHaveBeenCalledWith('pr-60');
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'done', expect.anything());
  });

  it('uses an explicit unmerged execution base for QA verification and merge target', async () => {
    const f = fixture();
    const child = { ...(await f.providers.backlog.get('60')), parentId: '10', baseBacklogId: '11' };
    const executionBase = { ...child, id: '11', title: 'stack base', parentId: undefined, baseBacklogId: undefined, state: 'verification', branchName: 'afk/backlog-11' };
    f.providers.backlog.get.mockImplementation(async (id: string) => id === '11' ? executionBase : child);
    const mergeBranch = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch,
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true, autoMerged: true });

    expect(mergeBranch).toHaveBeenCalledWith(process.cwd(), 'afk/backlog-11', 'afk/backlog-60');
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({ targetBranch: 'afk/backlog-11' }));
  });
});

describe('QARunner workspace independence', () => {
  it('rebuilds a released workspace before creating the QA worktree and releases it afterwards', async () => {
    // implementation releases its checkout on success, so QA must not depend
    // on it: the repository root is gone by the time QA starts.
    const f = fixture();
    const order: string[] = [];
    const release = vi.fn(async () => { order.push('release'); });
    const workspace = {
      repositories: [],
      primary: { handle: { path: '/rebuilt/repo' } },
      finish: vi.fn(async () => {}),
      release,
    };
    const prepareRepositories = { prepare: vi.fn(async () => { order.push('prepare'); return workspace; }) };
    f.branches.createVerificationWorktree.mockImplementation(async () => {
      order.push('createVerificationWorktree');
      return { branchName: 'qa-60', worktreePath: process.cwd() };
    });
    f.branches.cleanup.mockImplementation(async () => { order.push('cleanup'); });

    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
      projectRoot: '/workspace',
      repositories: [{ platform: 'github', projectKey: 'org/repo', repoRoot: '/workspace/repo', baseBranch: 'main', workingBranch: 'afk/backlog-60', primary: true }] as any,
      prepareRepositories: prepareRepositories as any,
      runtimeManager: { start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity: vi.fn() } as any,
    });

    const result = await runner.process('60');

    expect(result.success).toBe(true);
    expect(prepareRepositories.prepare).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ repoRoot: '/workspace/repo' })]),
      '/workspace',
    );
    expect(order).toEqual(['prepare', 'createVerificationWorktree', 'cleanup', 'release']);
    expect(workspace.finish).not.toHaveBeenCalled();
  });

  it('leaves unmanaged runs untouched when no managed workspace is configured', async () => {
    const f = fixture();
    const prepareRepositories = { prepare: vi.fn() };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeBranch: vi.fn(async () => {}),
      prepareRepositories: prepareRepositories as any,
      runtimeManager: { start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity: vi.fn() } as any,
    });

    expect((await runner.process('60')).success).toBe(true);
    expect(prepareRepositories.prepare).not.toHaveBeenCalled();
  });
});
