import { describe, expect, it } from 'vitest';
import { resolveRuntimeForProvider } from './runtime-binding.js';
import { DEFAULT_CODEX_CONFIG, type CodexConfig } from './codex-runtime.js';
import type { AgentRuntimeSelection } from './types.js';

const codexConfig = (overrides: Partial<CodexConfig> = {}): CodexConfig => ({
  ...DEFAULT_CODEX_CONFIG,
  appServer: { ...DEFAULT_CODEX_CONFIG.appServer },
  ...overrides,
});

const codexRuntime = (overrides: Partial<Extract<AgentRuntimeSelection, { kind: 'codex' }>> = {}) => ({
  kind: 'codex' as const,
  transport: 'exec' as const,
  auth: 'unknown' as const,
  provider: 'custom',
  startupTimeoutMs: 10_000,
  ...overrides,
});

describe('resolveRuntimeForProvider', () => {
  it('keeps the request-level Codex runtime when the step runs Codex', () => {
    const runtime = codexRuntime({ provider: 'afk-zyuncs', profile: 'afk' });

    expect(resolveRuntimeForProvider({ provider: 'codex', runtime })).toBe(runtime);
  });

  it('resolves a Codex runtime from configuration when the request level had none', () => {
    // The production shape: the request-level provider was not Codex, so the
    // request carried {kind:'default'} and the step's Codex settings would
    // have been dropped.
    const resolved = resolveRuntimeForProvider({
      provider: 'codex',
      runtime: { kind: 'default' },
      codex: codexConfig({ provider: 'afk-zyuncs', profile: 'afk' }),
    });

    expect(resolved).toMatchObject({
      kind: 'codex',
      provider: 'afk-zyuncs',
      profile: 'afk',
      transport: 'exec',
    });
  });

  it('never hands a Codex runtime to a non-Codex provider', () => {
    const resolved = resolveRuntimeForProvider({
      provider: 'claude-code',
      runtime: codexRuntime({ provider: 'afk-zyuncs', profile: 'afk' }),
    });

    expect(resolved).toBeUndefined();
  });

  it('keeps no runtime for a non-Codex provider', () => {
    expect(resolveRuntimeForProvider({ provider: 'claude-code' })).toBeUndefined();
    expect(resolveRuntimeForProvider({ provider: 'cursor', runtime: { kind: 'default' } })).toBeUndefined();
  });

  it('falls back to the default Codex configuration when AFK has none', () => {
    const resolved = resolveRuntimeForProvider({ provider: 'codex' });

    expect(resolved).toMatchObject({ kind: 'codex', provider: 'auto', transport: 'exec' });
  });

  it('preserves the configured Codex transport and endpoint', () => {
    const resolved = resolveRuntimeForProvider({
      provider: 'codex',
      codex: codexConfig({ transport: 'app-server', appServer: { endpoint: 'stdio://', startupTimeoutMs: 5_000 } }),
    });

    expect(resolved).toMatchObject({ kind: 'codex', transport: 'app-server', endpoint: 'stdio://' });
  });
});
