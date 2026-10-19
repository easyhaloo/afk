import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { BudgetManager } from './budget.js';
import { BudgetStore, BudgetStoreCorruptionError } from './budget-store.js';
import { WorkflowRunner } from '../workflow-engine.js';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { ProviderBundle } from '@afk/infrastructure';
import type { RunObserver } from '../../observability/run-observer.js';

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
      expect(await readFile(join(root, '.afk', 'budgets', `${encodeURIComponent('gitlab:org/repo#42')}.json`), 'utf8')).toContain('session-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for corrupt snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-budget-corrupt-'));
    try {
      const store = new BudgetStore(root, 'work-item-42');
      const path = join(root, '.afk', 'budgets', `${encodeURIComponent('work-item-42')}.json`);
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
      if (condition === 'corrupt') await writeFile(join(root, '.afk', 'budgets', `${encodeURIComponent('github:org/repo#42')}.json`), '{}');
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
    });
    const initial = execution('context_high', 10);
    const resumed = execution('completed', 20);
    const persisted: Array<ReturnType<BudgetManager['snapshot']>> = [];
    const createExecution = vi.fn().mockResolvedValueOnce(initial).mockImplementationOnce(async () => {
      expect(persisted.at(-1)?.used).toBe(1);
      return resumed;
    });
    const runner = new WorkflowRunner({} as ProviderBundle, {
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
    expect(budget.snapshot()).toMatchObject({ used: 1, tokens: 20, sessions: { 'native-session': 20 } });
    expect(persisted.at(-1)).toEqual(budget.snapshot());
  });
});
