import { workspaceDataDirectory } from '../../infrastructure/workspace.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { BudgetManager } from './budget.js';
import { BudgetStore, BudgetStoreCorruptionError } from './budget-store.js';
import { WorkflowRunner } from '../workflow-engine.js';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import type { RunObserver } from '../../observability/run-observer.js';
import { handoffDocPath } from './handoff.js';

describe('BudgetStore', () => {
  it('persists a work item budget and deduplicates sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-budget-'));
    try {
      const manager = new BudgetManager(3, 1000);
      expect(manager.recordSession('session-1', 100)).toBe(true);
      expect(manager.recordSession('session-1', 100)).toBe(false);
      manager.recordHandoff();
      const store = new BudgetStore(root, 'gitlab:org/repo#42');
      await store.save(manager.snapshot());

      const restored = await store.load();
      expect(restored).toMatchObject({ used: 1, tokens: 100, sessions: { 'session-1': 100 } });
      const nextRun = BudgetManager.fromSnapshot(restored!, 3, 1000);
      expect(nextRun.recordSession('session-1', 100)).toBe(false);
      expect(nextRun.recordSession('session-1', 150)).toBe(true);
      expect(nextRun.tokens).toBe(150);
      expect(await new BudgetStore(root, 'gitlab:other/repo#42').load()).toBeUndefined();
      expect(await readFile(join(workspaceDataDirectory(root), 'budgets', `${encodeURIComponent('gitlab:org/repo#42')}.json`), 'utf8')).toContain('session-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for corrupt snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-budget-corrupt-'));
    try {
      const store = new BudgetStore(root, 'work-item-42');
      const path = join(workspaceDataDirectory(root), 'budgets', `${encodeURIComponent('work-item-42')}.json`);
      await store.save({ used: 0, tokens: 0, sessions: {} });
      await writeFile(path, '{broken', 'utf8');
      await expect(store.load()).rejects.toBeInstanceOf(BudgetStoreCorruptionError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WorkflowRunner budget guard', () => {
  it('does not create an agent execution after the persisted budget is exhausted', async () => {
    const createExecution = vi.fn();
    const handoff = vi.fn(async () => 'terminated' as const);
    const transition = vi.fn(async () => {});
    const setExecutionMode = vi.fn(async () => {});
    const runner = new WorkflowRunner({ backlog: { transition, setExecutionMode } } as unknown as ProviderBundle, {
      observer: { record: vi.fn() } as unknown as RunObserver,
      agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution } as unknown as AgentProvider,
      coordinatorFactory: () => ({ handoff }) as never,
    });
    (runner as any).activeBacklog = { id: '42' };

    const result = await (runner as any).runPhase({
      iid: 42,
      session: 'run-42',
      wtPath: '/tmp/worktree',
      hardTimeoutMs: 1000,
      completionTimeoutMs: 1000,
      contextHighTokens: 100,
      budget: BudgetManager.forTest(1, 100, 1, 1000),
      persistBudget: vi.fn(),
      prompt: 'work',
      signalType: 'goal_complete',
      executionMode: 'batch',
      completionKind: 'task',
      sandbox: {},
    });

    expect(result).toEqual({ completed: false });
    expect(createExecution).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith('42', 'blocked', expect.objectContaining({ reason: expect.stringContaining('budget') }));
    expect(setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
  });

  it.each(['exhausted', 'corrupt'] as const)('restores a %s ledger before preparing work or starting an agent', async condition => {
    const root = await mkdtemp(join(tmpdir(), 'afk-budget-run-'));
    try {
      const store = new BudgetStore(root, 'github:org/repo#42');
      await store.save({ used: 1, tokens: 100, sessions: { 'session-1': 100 } });
      if (condition === 'corrupt') await writeFile(join(workspaceDataDirectory(root), 'budgets', `${encodeURIComponent('github:org/repo#42')}.json`), '{}');
      const createBranch = vi.fn();
      const createExecution = vi.fn();
      const transition = vi.fn(async () => {});
      const runner = new WorkflowRunner({ backlog: { transition, setExecutionMode: vi.fn() }, branches: { createBranch } } as unknown as ProviderBundle, {
        observer: { record: vi.fn() } as unknown as RunObserver,
        agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution } as unknown as AgentProvider,
      }) as any;
      runner.activeBacklog = { id: '42', providerRef: 'github:org/repo#42' };
      const result = runner.runBody({ workspaceRoot: root, maxHandoffs: 1, maxTotalTokens: 1000 });
      if (condition === 'corrupt') await expect(result).rejects.toBeInstanceOf(BudgetStoreCorruptionError);
      else await expect(result).resolves.toEqual({ success: false });
      expect(createBranch).not.toHaveBeenCalled();
      expect(createExecution).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes once, reserves the last handoff before launch, and records native session totals once', async () => {
    const budget = new BudgetManager(1, 1000);
    const completion = { type: 'goal_complete', kind: 'ac', result: 'PASS', summary: 'verified' };
    const execution = (status: 'context_high' | 'completed', tokens: number) => ({
      id: `execution-${tokens}`, metadata: { provider: 'claude-code' },
      waitForResult: vi.fn(async () => ({ version: 1, runId: `execution-${tokens}`, provider: 'batch', status, sessionId: 'native-session',
        usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens }, commits: [], structuredOutput: completion })),
      captureSession: vi.fn(async () => ({ capturedAt: new Date().toISOString() })),
      captureOutput: vi.fn(async () => 'budget recovery transcript'),
      kill: vi.fn(async () => {}),
    });
    const initial = execution('context_high', 10);
    const resumed = execution('completed', 20);
    const persisted: Array<ReturnType<BudgetManager['snapshot']>> = [];
    const createExecution = vi.fn().mockResolvedValueOnce(initial).mockImplementationOnce(async () => {
      expect(persisted.at(-1)?.used).toBe(1);
      expect(initial.kill).toHaveBeenCalledOnce();
      expect(await readFile(handoffDocPath('/tmp/worktree', '42', 1), 'utf8')).toContain('budget recovery transcript');
      return resumed;
    });
    const transition = vi.fn(async () => {});
    const setExecutionMode = vi.fn(async () => {});
    const runner = new WorkflowRunner({ backlog: { transition, setExecutionMode } } as unknown as ProviderBundle, {
      observer: { record: vi.fn() } as unknown as RunObserver,
      agentProvider: { name: 'claude-code', capabilities: new Set(['resume']), createExecution, restoreSession: vi.fn() } as unknown as AgentProvider,
    }) as any;
    runner.heartbeatRuntime = vi.fn();
    runner.writeRuntimeDiagnostics = vi.fn();
    runner.sessionStoreChainFactory = () => ({ saveFirst: vi.fn(), loadFirst: vi.fn(async () => ({ snapshot: {}, storeName: 'file' })) });
    const result = await runner.runPhase({
      iid: 42, session: 'session-42', wtPath: '/tmp/worktree', hardTimeoutMs: 1000, completionTimeoutMs: 1000,
      contextHighTokens: 100, budget, persistBudget: async () => { persisted.push(budget.snapshot()); },
      prompt: 'verify', signalType: 'goal_complete', executionMode: 'batch', completionKind: 'ac', sandbox: {},
    });
    expect(result).toEqual({ completed: true, output: completion });
    expect(createExecution).toHaveBeenCalledTimes(2);
    expect(initial.waitForResult).toHaveBeenCalledOnce();
    expect(resumed.waitForResult).toHaveBeenCalledOnce();
    expect(initial.captureOutput).toHaveBeenCalledOnce();
    expect(initial.captureSession.mock.invocationCallOrder[0]).toBeLessThan(initial.captureOutput.mock.invocationCallOrder[0]);
    expect(initial.captureOutput.mock.invocationCallOrder[0]).toBeLessThan(initial.kill.mock.invocationCallOrder[0]);
    expect(budget.snapshot()).toMatchObject({ used: 1, tokens: 20, sessions: { 'native-session': 20 } });
    expect(persisted.at(-1)).toEqual(budget.snapshot());
    expect(transition).not.toHaveBeenCalled();
    expect(setExecutionMode).not.toHaveBeenCalled();
  });

  it.each(['budget', 'tokens'] as const)('stops batch execution and preserves recovery state at the %s boundary', async reason => {
    const root = await mkdtemp(join(tmpdir(), 'afk-budget-terminal-'));
    try {
      const budget = new BudgetManager(1, reason === 'tokens' ? 10 : 1000);
      const store = new BudgetStore(root, 'github:fixture/repo#42');
      const executions = Array.from({ length: 2 }, (_value, index) => ({
        id: `terminal-${index}`, metadata: { provider: 'claude-code' },
        waitForResult: vi.fn(async () => ({ version: 1, runId: `terminal-${index}`, provider: 'batch', status: 'context_high',
          sessionId: 'native-budget-session', usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 }, commits: [] })),
        captureOutput: vi.fn(async () => `terminal recovery ${index}`),
        kill: vi.fn(async () => {}),
      }));
      const createExecution = vi.fn().mockResolvedValueOnce(executions[0]).mockResolvedValueOnce(executions[1]);
      const transition = vi.fn(async () => {});
      const setExecutionMode = vi.fn(async () => {});
      const runner = new WorkflowRunner({ backlog: { transition, setExecutionMode } } as unknown as ProviderBundle, {
        observer: { record: vi.fn() } as unknown as RunObserver,
        agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution } as unknown as AgentProvider,
      }) as any;
      const result = await runner.runPhase({
        iid: 42, session: 'budget-terminal', wtPath: root, hardTimeoutMs: 1000, completionTimeoutMs: 1000,
        contextHighTokens: 10, budget, persistBudget: () => store.save(budget.snapshot()),
        prompt: 'work', signalType: 'goal_complete', executionMode: 'batch', completionKind: 'task', sandbox: {},
      });
      const started = reason === 'budget' ? 2 : 1;
      expect(result).toEqual({ completed: false });
      expect(createExecution).toHaveBeenCalledTimes(started);
      for (const execution of executions.slice(0, started)) expect(execution.kill).toHaveBeenCalledOnce();
      if (started === 2) expect(executions[0].kill.mock.invocationCallOrder[0]).toBeLessThan(createExecution.mock.invocationCallOrder[1]);
      const restored = await store.load();
      expect(restored).toEqual({ version: 1, workItemKey: 'github:fixture/repo#42', used: reason === 'budget' ? 1 : 0,
        tokens: 10, sessions: { 'native-budget-session': 10 } });
      expect(BudgetManager.fromSnapshot(restored!, 1, reason === 'tokens' ? 10 : 1000).exhaustionReason()).toBe(reason);
      const doc = handoffDocPath(root, '42', 1).replace(/-1\.md$/, '-terminal.md');
      expect(await readFile(doc, 'utf8')).toContain(`terminal recovery ${started - 1}`);
      if (started === 2) expect(await readFile(handoffDocPath(root, '42', 1), 'utf8')).toContain('terminal recovery 0');
      expect(transition).toHaveBeenCalledWith('42', 'blocked', { reason });
      expect(setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
