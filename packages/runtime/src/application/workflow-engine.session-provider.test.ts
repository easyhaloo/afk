import { describe, expect, it, vi } from 'vitest';
import type { ObservationContext } from '@afk/core';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import type { Sandbox } from '../infrastructure/sandbox/types.js';
import type { RunObserver } from '../observability/run-observer.js';
import { CursorProvider } from '../domain/agents/cursor.js';
import { PiProvider } from '../domain/agents/pi.js';
import { AgentProviderRegistry } from '../domain/agents/registry.js';
import type { AgentExecution, AgentStartOptions, SessionSnapshot } from '../domain/agents/types.js';
import type { Step, StepResult } from '../domain/templates/types.js';
import type { SessionSaveOptions, SessionStoreChain } from './sessions/types.js';
import { BudgetManager } from './workflows/budget.js';
import { WorkflowRunner } from './workflow-engine.js';
import { createHandoffCoordinator } from './workflows/handoff.js';

describe('workflow step session provider provenance', () => {
  it.each([
    { name: 'cursor', create: () => new CursorProvider(), flag: '--resume' },
    { name: 'pi', create: () => new PiProvider(), flag: '--session' },
  ])('saves and resumes the actual $name step provider when the request provider differs', async ({ name, create, flag }) => {
    const provider = create();
    let stopped = false;
    let saved: SessionSnapshot | undefined;
    const saveFirst = vi.fn(async (options: SessionSaveOptions) => {
      saved = options.snapshot;
      return { path: 'memory', checksum: 'fixture', provider: options.provider };
    });
    const chain = { saveFirst, loadFirst: vi.fn(async () => saved ? { snapshot: saved, storeName: 'memory' } : undefined) } as unknown as SessionStoreChain;
    const startAgent = vi.fn(async (options: AgentStartOptions): Promise<AgentExecution> => {
      const index = startAgent.mock.calls.length;
      if (index > 1) expect(stopped).toBe(true);
      options.parseLine?.(JSON.stringify(name === 'cursor'
        ? { type: 'system', subtype: 'init', session_id: 'native-step-session' }
        : { type: 'session', version: 3, id: 'native-step-session' }));
      return {
        id: `fixture-${index}`, metadata: options.metadata,
        waitForEvent: async () => null,
        waitForResult: async () => ({ version: 1, runId: `fixture-${index}`, provider: name, status: index === 1 ? 'context_high' : 'completed', commits: [] }),
        captureOutput: async () => '', captureSession: async () => undefined,
        interrupt: async () => {}, kill: async () => { stopped = true; }, resume: async () => { throw new Error('host resume must not replace provider resume'); },
      };
    });
    const sandbox = { startAgent } as unknown as Sandbox;
    const requestCreate = vi.fn();
    const workflow = new WorkflowRunner({ backlog: { claim: vi.fn(async () => null) } } as unknown as ProviderBundle, {
      observer: { record: vi.fn(async () => undefined) } as unknown as RunObserver,
      coordinatorFactory: createHandoffCoordinator,
      agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution: requestCreate },
      agentProviderRegistry: new AgentProviderRegistry([provider]),
      sandboxProvider: { name: 'local', capabilities: new Set() } as never,
      sessionStoreChain: () => chain,
    });
    const internals = workflow as unknown as {
      sandbox: Sandbox;
      observationContext: ObservationContext;
      runStep(step: Step, context: unknown, results: Record<string, StepResult>): Promise<StepResult>;
    };
    internals.sandbox = sandbox;
    internals.observationContext = {
      traceId: 'session-fixture', runId: 'fixture-42', workItemId: 'github:fixture/repo#42',
      profileId: 'development', attempt: 1, actor: { kind: 'system', id: 'session-test' }, purpose: 'learning',
    };
    const budget = new BudgetManager(3, 1000000);
    const persistBudget = vi.fn(async () => {});
    const result = await internals.runStep({ id: 'implement', prompt: 'implement the fixture', provider: name }, {
      iid: 42, session: 'afk-logical-step', primaryWtPath: '/tmp/afk-step-session-fixture', primaryBranch: 'feature',
      hardTimeoutMs: 10000, completionTimeoutMs: 10000, idleTimeoutMs: 5000, contextHighTokens: 100,
      budget, persistBudget, executionMode: 'batch',
    }, {});
    expect(result.status).toBe('completed');
    expect(saveFirst).toHaveBeenCalledOnce();
    expect(saveFirst).toHaveBeenCalledWith(expect.objectContaining({ runId: 'issue-42-gen-1', provider: name,
      snapshot: expect.objectContaining({ sessionId: 'native-step-session', checkpoint: expect.objectContaining({ provider: name }) }) }));
    expect(requestCreate).not.toHaveBeenCalled();
    expect(startAgent).toHaveBeenCalledTimes(2);
    expect(startAgent.mock.calls[0][0].command.argv).not.toContain(flag);
    expect(startAgent.mock.calls[1][0].command.argv.slice(-2)).toEqual([flag, 'native-step-session']);
    expect(budget.used).toBe(1);
    expect(persistBudget).toHaveBeenCalledOnce();
  });
});
