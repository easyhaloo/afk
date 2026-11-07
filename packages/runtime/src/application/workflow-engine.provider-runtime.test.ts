import { describe, expect, it, vi } from 'vitest';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import { WorkflowRunner } from './workflow-engine.js';
import type { RunObserver } from '../observability/run-observer.js';
import type { AgentRuntimeSelection } from '../domain/agents/types.js';
import { DEFAULT_CODEX_CONFIG, type CodexConfig } from '../domain/agents/codex-runtime.js';

/**
 * A step may run a different provider than the request did.
 *
 * When it does, the step must not inherit the request-level provider's
 * runtime: the runtime carries provider-specific settings (for Codex:
 * provider, profile and transport), so the wrong runtime silently points the
 * agent at the wrong endpoint instead of failing.
 */
const codexConfig = (overrides: Partial<CodexConfig> = {}): CodexConfig => ({
  ...DEFAULT_CODEX_CONFIG,
  appServer: { ...DEFAULT_CODEX_CONFIG.appServer },
  ...overrides,
});

function runnerWith(input: {
  agentProvider: 'claude-code' | 'codex';
  agentRuntime?: AgentRuntimeSelection;
  codex?: CodexConfig;
}) {
  const prepareRuntime = vi.fn(async (runtime: AgentRuntimeSelection) => runtime);
  const workflow = new WorkflowRunner(
    { backlog: { claim: vi.fn(async () => null) } } as unknown as ProviderBundle,
    {
      observer: { record: vi.fn(async () => undefined) } as unknown as RunObserver,
      agentProvider: { name: input.agentProvider, capabilities: new Set(), createExecution: vi.fn() } as never,
      agentRuntime: input.agentRuntime,
      prepareRuntime,
      config: { agents: { codex: input.codex ?? codexConfig({ provider: 'afk-zyuncs', profile: 'afk' }) } } as never,
    },
  );
  const runtimeFor = (provider: 'claude-code' | 'codex') =>
    (workflow as unknown as { runtimeForProvider: (p: string) => Promise<AgentRuntimeSelection | undefined> })
      .runtimeForProvider(provider);
  return { workflow, runtimeFor, prepareRuntime };
}

describe('WorkflowRunner runtime binding', () => {
  it('gives a Codex step the Codex runtime when the request level had none', async () => {
    // The production shape: the request ran Claude Code, so it carried no
    // Codex runtime, and the Codex step lost its profile entirely.
    const { runtimeFor, prepareRuntime } = runnerWith({
      agentProvider: 'claude-code',
      agentRuntime: { kind: 'default' },
    });

    const runtime = await runtimeFor('codex');

    expect(runtime).toMatchObject({ kind: 'codex', provider: 'afk-zyuncs', profile: 'afk', transport: 'exec' });
    expect(prepareRuntime).toHaveBeenCalledTimes(1);
  });

  it('reuses the request-level Codex runtime instead of probing twice', async () => {
    const requestRuntime: AgentRuntimeSelection = {
      kind: 'codex',
      transport: 'exec',
      auth: 'unknown',
      provider: 'afk-zyuncs',
      profile: 'afk',
      startupTimeoutMs: 30_000,
    };
    const { runtimeFor, prepareRuntime } = runnerWith({
      agentProvider: 'codex',
      agentRuntime: requestRuntime,
    });

    const runtime = await runtimeFor('codex');

    expect(runtime).toBe(requestRuntime);
    expect(prepareRuntime).not.toHaveBeenCalled();
  });

  it('never hands a Codex runtime to a non-Codex provider', async () => {
    const { runtimeFor } = runnerWith({
      agentProvider: 'codex',
      agentRuntime: {
        kind: 'codex',
        transport: 'exec',
        auth: 'unknown',
        provider: 'afk-zyuncs',
        profile: 'afk',
        startupTimeoutMs: 30_000,
      },
    });

    expect(await runtimeFor('claude-code')).toBeUndefined();
  });

  it('probes a provider at most once per run', async () => {
    const { runtimeFor, prepareRuntime } = runnerWith({
      agentProvider: 'claude-code',
      agentRuntime: { kind: 'default' },
    });

    await runtimeFor('codex');
    await runtimeFor('codex');

    expect(prepareRuntime).toHaveBeenCalledTimes(1);
  });
});
