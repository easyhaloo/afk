import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CODEX_CONFIG,
  prepareAgentRuntime,
  probeCodexAppServerEndpoint,
  probeCodexReadiness,
  resolveCodexRuntime,
  type CodexConfig,
} from './codex-runtime';
import type { AppServerTransport, JsonRpcMessage } from './codex-app-server/transport';
import { createStdioAppServerTransport } from './codex-app-server/transport';

const config = (overrides: Partial<CodexConfig> = {}): CodexConfig => ({
  transport: 'auto',
  auth: 'auto',
  provider: 'auto',
  appServer: { startupTimeoutMs: 10_000 },
  ...overrides,
});

describe('resolveCodexRuntime', () => {
  it('allows enough startup time for a host app-server live turn', () => {
    expect(DEFAULT_CODEX_CONFIG.appServer.startupTimeoutMs).toBe(30_000);
  });

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

  it('rejects host profiles for app-server transports', () => {
    expect(() => resolveCodexRuntime({
      cli: { transport: 'app-server', profile: 'work' },
      config: config(),
    })).toThrow(/profile.*app-server/i);
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
    const run = vi.fn(async (_executable: string, args: string[]) => ({
      stdout: args[0] === 'doctor'
        ? JSON.stringify({ ready: true, auth: 'chatgpt', provider: 'openai', token: 'must-not-leak' })
        : '{"type":"turn.completed"}\n',
      stderr: '',
    }));

    await expect(probeCodexReadiness(resolveCodexRuntime({ cli: {}, config: config() }), run)).resolves.toEqual({
      ready: true,
      auth: 'chatgpt',
      provider: 'openai',
    });
    expect(run).toHaveBeenNthCalledWith(1, 'codex', ['doctor', '--json'], { timeoutMs: 10_000 });
    expect(run.mock.calls[1][1]).toEqual(expect.arrayContaining(['exec', '--json', '--ephemeral', '--sandbox', 'read-only']));
  });

  it('reads current doctor diagnostics and ignores unrelated terminal failures', async () => {
    const run = vi.fn(async (_executable: string, args: string[]) => ({
      stdout: args[0] === 'doctor'
        ? JSON.stringify({
            schemaVersion: 1,
            overallStatus: 'fail',
            checks: {
              'auth.credentials': {
                status: 'warning',
                details: { 'stored auth mode': 'api_key', 'stored API key': 'true' },
              },
              'config.load': { status: 'ok', details: { 'model provider': 'custom' } },
              'network.provider_reachability': { status: 'ok' },
              'terminal.env': { status: 'fail', summary: 'TERM=dumb' },
            },
          })
        : '{"type":"turn.completed"}\n',
      stderr: '',
    }));

    await expect(probeCodexReadiness(resolveCodexRuntime({ cli: {}, config: config() }), run)).resolves.toEqual({
      ready: true,
      auth: 'api',
      provider: 'custom',
    });
  });

  it('fails redacted readiness when the live model probe rejects configured credentials', async () => {
    const run = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'doctor') {
        return { stdout: JSON.stringify({ ready: true, auth: 'api', provider: 'custom' }), stderr: '' };
      }
      throw new Error('401 INVALID_API_KEY sk-secret-fragment');
    });

    const result = await probeCodexReadiness(resolveCodexRuntime({ cli: {}, config: config() }), run);
    expect(result).toEqual({ ready: false, code: 'AUTH_INVALID', message: 'Codex authentication is not ready' });
    expect(JSON.stringify(result)).not.toContain('secret-fragment');
  });

  it('rejects an explicit auth mode that differs from host diagnostics', async () => {
    const run = vi.fn(async (_executable: string, args: string[]) => ({
      stdout: args[0] === 'doctor'
        ? JSON.stringify({ ready: true, auth: 'chatgpt', provider: 'openai' })
        : '{"type":"turn.completed"}\n',
      stderr: '',
    }));
    const runtime = resolveCodexRuntime({ cli: { auth: 'api' }, config: config() });

    await expect(probeCodexReadiness(runtime, run)).resolves.toEqual({
      ready: false, code: 'AUTH_INVALID', message: 'Codex authentication is not ready',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('applies profile and provider selection to doctor and live probes', async () => {
    const run = vi.fn(async (_executable: string, args: string[]) => ({
      stdout: args[0] === 'doctor'
        ? JSON.stringify({ ready: true, auth: 'api', provider: 'custom' })
        : '{"type":"turn.completed"}\n',
      stderr: '',
    }));
    const runtime = resolveCodexRuntime({
      cli: { profile: 'work', provider: 'custom' },
      config: config(),
    });

    await expect(probeCodexReadiness(runtime, run)).resolves.toMatchObject({ ready: true });
    expect(run.mock.calls[0][1]).not.toContain('--profile');
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--config', 'model_provider="custom"',
    ]));
    expect(run.mock.calls[1][1]).toEqual(expect.arrayContaining([
      '--profile', 'work', '--config', 'model_provider="custom"',
    ]));
  });

  it('lets an exec profile resolve its own provider when provider is auto', async () => {
    const run = vi.fn(async (_executable: string, args: string[]) => ({
      stdout: args[0] === 'doctor'
        ? JSON.stringify({ ready: true, auth: 'api', provider: 'base-provider' })
        : '{"type":"turn.completed"}\n',
      stderr: '',
    }));
    const runtime = resolveCodexRuntime({ cli: { profile: 'work' }, config: config() });

    const readiness = await probeCodexReadiness(runtime, run);
    const prepared = await prepareAgentRuntime(runtime, async () => readiness);

    expect(readiness).toMatchObject({ ready: true, provider: 'auto' });
    expect(prepared).toMatchObject({ profile: 'work', provider: 'auto' });
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
    expect(run).not.toHaveBeenCalled();
    expect(checkEndpoint).toHaveBeenCalledWith(runtime);
  });

  it('probes spawned stdio through app-server without requiring exec readiness', async () => {
    const runtime = resolveCodexRuntime({
      cli: { transport: 'app-server', endpoint: 'stdio://' },
      config: config(),
    });
    const run = vi.fn(async () => { throw new Error('exec provider is unavailable'); });
    const checkEndpoint = vi.fn(async () => {});

    await expect(probeCodexReadiness(runtime, run, checkEndpoint)).resolves.toEqual({
      ready: true, auth: 'unknown', provider: 'auto',
    });
    expect(run).not.toHaveBeenCalled();
    expect(checkEndpoint).toHaveBeenCalledWith(runtime);
  });

  it('preserves a classified remote live-turn authentication failure', async () => {
    const runtime = resolveCodexRuntime({
      cli: {
        transport: 'app-server', endpoint: 'ws://localhost:7777', provider: 'custom',
      },
      config: config(),
    });
    const checkEndpoint = vi.fn(async () => {
      throw Object.assign(new Error('upstream secret'), { code: 'AUTH_INVALID' });
    });

    const result = await probeCodexReadiness(runtime, vi.fn(), checkEndpoint);

    expect(result).toEqual({
      ready: false, code: 'AUTH_INVALID', message: 'Codex authentication is not ready',
    });
    expect(JSON.stringify(result)).not.toContain('upstream secret');
  });
});

describe('probeCodexAppServerEndpoint', () => {
  it('preserves a missing CLI classification for spawned stdio', async () => {
    const runtime = resolveCodexRuntime({
      cli: { transport: 'app-server', endpoint: 'stdio://' },
      config: config(),
    });
    await expect(probeCodexAppServerEndpoint(
      runtime,
      async () => createStdioAppServerTransport('/afk-missing-codex-app-server', []),
    )).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
  });

  it('classifies a live-turn timeout as endpoint readiness, not invalid authentication', async () => {
    const queue: JsonRpcMessage[] = [];
    const readers: Array<(result: IteratorResult<JsonRpcMessage>) => void> = [];
    let closed = false;
    const push = (message: JsonRpcMessage) => {
      const reader = readers.shift();
      if (reader) reader({ done: false, value: message });
      else queue.push(message);
    };
    const transport: AppServerTransport = {
      endpointKind: 'stdio',
      async send(message) {
        if (message.id === undefined) return;
        if (message.method === 'initialize') push({ id: message.id, result: {} });
        if (message.method === 'thread/start') push({ id: message.id, result: { thread: { id: 'probe-thread' } } });
        if (message.method === 'turn/start') push({ id: message.id, result: { turn: { id: 'probe-turn' } } });
      },
      messages: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const message = queue.shift();
            if (message) return Promise.resolve({ done: false, value: message });
            if (closed) return Promise.resolve({ done: true, value: undefined });
            return new Promise(resolve => readers.push(resolve));
          },
        }),
      }),
      async close() {
        closed = true;
        for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
      },
    };
    const runtime = resolveCodexRuntime({
      cli: { transport: 'app-server', endpoint: 'stdio://', startupTimeoutMs: 5 },
      config: config(),
    });

    await expect(probeCodexReadiness(
      runtime,
      vi.fn(),
      selected => probeCodexAppServerEndpoint(selected, async () => transport),
    )).resolves.toEqual({
      ready: false,
      code: 'ENDPOINT_UNREACHABLE',
      message: 'Codex app-server endpoint is not reachable',
    });
  });

  it('requires a successful read-only protocol turn and closes the transport', async () => {
    const sent: JsonRpcMessage[] = [];
    let closed = false;
    const queue: JsonRpcMessage[] = [];
    const readers: Array<(result: IteratorResult<JsonRpcMessage>) => void> = [];
    const push = (message: JsonRpcMessage) => {
      const reader = readers.shift();
      if (reader) reader({ done: false, value: message });
      else queue.push(message);
    };
    const transport: AppServerTransport = {
      endpointKind: 'ws',
      async send(message) {
        sent.push(message);
        if (message.id === undefined) return;
        if (message.method === 'initialize') push({ jsonrpc: '2.0', id: message.id, result: {} });
        if (message.method === 'thread/start') push({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'probe-thread' } } });
        if (message.method === 'turn/start') {
          push({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'probe-turn' } } });
          push({
            jsonrpc: '2.0', method: 'error',
            params: { willRetry: true, message: 'transient upstream failure' },
          });
          push({
            jsonrpc: '2.0', method: 'turn/completed',
            params: { turn: { id: 'probe-turn', status: 'completed' } },
          });
        }
      },
      messages: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const message = queue.shift();
            if (message) return Promise.resolve({ done: false, value: message });
            if (closed) return Promise.resolve({ done: true, value: undefined });
            return new Promise(resolve => readers.push(resolve));
          },
        }),
      }),
      async close() {
        closed = true;
        for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
      },
    };
    const runtime = resolveCodexRuntime({
      cli: { transport: 'app-server', endpoint: 'ws://localhost:7777' },
      config: config(),
    });

    await probeCodexAppServerEndpoint(runtime, async () => transport);

    expect(sent.map(message => message.method)).toEqual([
      'initialize', 'initialized', 'thread/start', 'turn/start',
    ]);
    expect(sent[2]).toMatchObject({
      params: { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only' },
    });
    expect(sent[2].params).not.toHaveProperty('modelProvider');
    expect(sent[3]).toMatchObject({
      params: {
        threadId: 'probe-thread',
        input: [{ type: 'text', text: expect.stringContaining('READY'), text_elements: [] }],
      },
    });
    expect(closed).toBe(true);
  });
});
