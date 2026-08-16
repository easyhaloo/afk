import { describe, expect, it, vi } from 'vitest';
import {
  prepareAgentRuntime,
  probeCodexReadiness,
  resolveCodexRuntime,
  type CodexConfig,
} from './codex-runtime';

const config = (overrides: Partial<CodexConfig> = {}): CodexConfig => ({
  transport: 'auto',
  auth: 'auto',
  provider: 'auto',
  appServer: { startupTimeoutMs: 10_000 },
  ...overrides,
});

describe('resolveCodexRuntime', () => {
  it('defaults to host-managed exec with unknown authentication', () => {
    expect(resolveCodexRuntime({ cli: {}, config: config() })).toEqual({
      kind: 'codex',
      transport: 'exec',
      auth: 'unknown',
      provider: 'auto',
      startupTimeoutMs: 10_000,
    });
  });

  it('uses CLI values before AFK configuration', () => {
    expect(resolveCodexRuntime({
      cli: { transport: 'app-server', auth: 'chatgpt', provider: 'openai' },
      config: config({
        transport: 'exec',
        auth: 'api',
        provider: 'custom',
        appServer: { endpoint: 'stdio://', startupTimeoutMs: 4_000 },
      }),
    })).toMatchObject({
      transport: 'app-server',
      auth: 'chatgpt',
      provider: 'openai',
      endpoint: 'stdio://',
      startupTimeoutMs: 4_000,
    });
  });

  it('selects app-server automatically only for an explicit endpoint', () => {
    expect(resolveCodexRuntime({
      cli: {},
      config: config({ appServer: { endpoint: 'unix:///tmp/codex.sock', startupTimeoutMs: 10_000 } }),
    })).toMatchObject({ transport: 'app-server', endpoint: 'unix:///tmp/codex.sock' });
  });

  it('uses redacted host diagnostics only for auto auth and provider', () => {
    expect(resolveCodexRuntime({
      cli: {},
      config: config(),
      host: { auth: 'chatgpt', provider: 'openai' },
    })).toMatchObject({ auth: 'chatgpt', provider: 'openai' });
  });

  it('rejects unsupported endpoint schemes', () => {
    expect(() => resolveCodexRuntime({
      cli: { transport: 'app-server', endpoint: 'https://example.test/codex' },
      config: config(),
    })).toThrow(/endpoint/i);
  });
});

describe('probeCodexReadiness', () => {
  it('does not let host readiness diagnostics override explicit runtime choices', async () => {
    const runtime = resolveCodexRuntime({
      cli: { auth: 'api', provider: 'custom' },
      config: config(),
    });
    const prepared = await prepareAgentRuntime(
      runtime,
      async () => ({ ready: true, auth: 'chatgpt', provider: 'openai' }),
    );

    expect(prepared).toMatchObject({ auth: 'api', provider: 'custom' });
  });

  it('returns redacted host diagnostics from codex doctor', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({ ready: true, auth: 'chatgpt', provider: 'openai', token: 'must-not-leak' }),
      stderr: '',
    }));

    await expect(probeCodexReadiness(resolveCodexRuntime({ cli: {}, config: config() }), run)).resolves.toEqual({
      ready: true,
      auth: 'chatgpt',
      provider: 'openai',
    });
    expect(run).toHaveBeenCalledWith('codex', ['doctor', '--json']);
  });

  it('maps authentication failures without exposing command output', async () => {
    const run = vi.fn(async () => {
      const error = new Error('401 INVALID_API_KEY sk-secret-fragment') as Error & { code?: number; stderr?: string };
      error.code = 1;
      error.stderr = 'upstream rejected sk-secret-fragment';
      throw error;
    });

    const result = await probeCodexReadiness(resolveCodexRuntime({
      cli: { auth: 'api' },
      config: config(),
    }), run);

    expect(result).toEqual({
      ready: false,
      code: 'AUTH_INVALID',
      message: 'Codex authentication is not ready',
    });
    expect(JSON.stringify(result)).not.toContain('secret-fragment');
  });

  it('reports a missing CLI without leaking the searched environment', async () => {
    const run = vi.fn(async () => {
      const error = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    await expect(probeCodexReadiness(resolveCodexRuntime({ cli: {}, config: config() }), run)).resolves.toEqual({
      ready: false,
      code: 'CLI_NOT_FOUND',
      message: 'Codex CLI was not found on PATH',
    });
  });

  it('checks configured remote app-server endpoints before execution', async () => {
    const runtime = resolveCodexRuntime({
      cli: { transport: 'app-server', endpoint: 'unix:///tmp/missing-codex.sock' },
      config: config(),
    });
    const run = vi.fn(async () => ({ stdout: '{"ready":true}', stderr: '' }));
    const checkEndpoint = vi.fn(async () => { throw new Error('connect ENOENT /tmp/missing-codex.sock'); });

    await expect(probeCodexReadiness(runtime, run, checkEndpoint)).resolves.toEqual({
      ready: false,
      code: 'ENDPOINT_UNREACHABLE',
      message: 'Codex app-server endpoint is not reachable',
    });
    expect(checkEndpoint).toHaveBeenCalledWith(runtime);
  });
});
