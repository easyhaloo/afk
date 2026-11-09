import { describe, expect, it, vi } from 'vitest';
import { createRemoteContainerPlugin } from './builtin-providers.js';
import { createConfiguredPlugins } from './configured.js';
import { PluginRuntime } from './runtime.js';
import {
  createRemoteContainerCliTransport, createRemoteContainerHttpTransport,
  RemoteContainerSandboxProvider,
} from '../../infrastructure/sandbox/remote-container.js';

describe('remote container plugin health', () => {
  it.each(['cli', 'http'] as const)('reports an unprobed %s transport as unknown without requests', async kind => {
    const request = vi.fn();
    const provider = new RemoteContainerSandboxProvider({ kind, request });
    const runtime = new PluginRuntime();
    await runtime.activate(createRemoteContainerPlugin(provider));
    await expect(runtime.health()).resolves.toMatchObject([{ status: 'unknown', message: expect.stringMatching(/no .*probe/i) }]);
    expect(provider.health).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['cli', 'http'] as const)('uses registered %s probes with their receiver and precise scope', async kind => {
    const request = vi.fn();
    const transport = { kind, request, health: vi.fn(async function (this: unknown) {
      expect(this).toBe(transport);
      return true;
    }) };
    const provider = new RemoteContainerSandboxProvider(transport);
    const runtime = new PluginRuntime();
    await runtime.activate(createRemoteContainerPlugin(provider));
    expect(transport.health).not.toHaveBeenCalled();
    await expect(runtime.health()).resolves.toMatchObject([{
      status: 'healthy', message: expect.stringMatching(/execution readiness was not checked/),
    }]);
    expect(transport.health).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    await expect(provider.health!()).resolves.toMatchObject({ status: 'ok' });
  });

  it('reports a negative probe as unhealthy', async () => {
    const provider = new RemoteContainerSandboxProvider({ kind: 'http', request: vi.fn(), health: vi.fn(async () => false) });
    await expect(createRemoteContainerPlugin(provider).health!()).resolves.toMatchObject({
      status: 'unhealthy', message: expect.stringMatching(/reported unavailable/),
    });
  });

  it.each([new Error('Bearer private-token https://user:password@example.test'), 'private-token'])('contains probe failures without exposing exception data (%#)', async failure => {
    const provider = new RemoteContainerSandboxProvider({ kind: 'cli', request: vi.fn(), health: vi.fn(() => { throw failure; }) });
    await expect(provider.health!()).resolves.toEqual({ status: 'unavailable', message: 'Remote container health probe failed' });
    const runtime = new PluginRuntime();
    await runtime.activate(createRemoteContainerPlugin(provider));
    await expect(runtime.health()).resolves.toEqual([{
      pluginId: 'sandbox.remote-container', status: 'unhealthy', message: 'Remote container health probe failed',
    }]);
  });

  it('keeps an injected HTTP request transport unprobed when no health callback exists', async () => {
    const request = vi.fn();
    const provider = new RemoteContainerSandboxProvider(createRemoteContainerHttpTransport({ request }));
    await expect(createRemoteContainerPlugin(provider).health!()).resolves.toMatchObject({ status: 'unknown' });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps configured CLI health unknown without launching its command', async () => {
    const remoteRun = vi.fn();
    const fetch = vi.fn();
    const [plugin] = await createConfiguredPlugins({
      configurations: [{ id: 'sandbox.remote-container', config: { transport: 'cli', command: 'remote-client' } }],
      remoteRun, fetch,
    });
    const runtime = new PluginRuntime();
    await runtime.activate(plugin);
    await expect(runtime.health()).resolves.toMatchObject([{ status: 'unknown' }]);
    expect(remoteRun).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(new RemoteContainerSandboxProvider(createRemoteContainerCliTransport({ command: 'remote-client', run: remoteRun })).health).toBeUndefined();
  });

  it.each([true, false] as const)('uses configured HTTP health with result %s', async healthy => {
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, Promise<Response>>(async () => new Response(JSON.stringify({ healthy }), { headers: { 'Content-Type': 'application/json' } }));
    const [plugin] = await createConfiguredPlugins({
      configurations: [{ id: 'sandbox.remote-container', config: {
        transport: 'http', endpoint: 'https://containers.example.test/api', token: { env: 'TOKEN' }, timeoutMs: 1234,
      } }],
      environment: { TOKEN: 'private-token' }, fetch,
    });
    const runtime = new PluginRuntime();
    await runtime.activate(plugin);
    expect(fetch).not.toHaveBeenCalled();
    await expect(runtime.health()).resolves.toMatchObject([{
      status: healthy ? 'healthy' : 'unhealthy',
      message: expect.stringMatching(healthy ? /execution readiness was not checked/ : /reported unavailable/),
    }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].toString()).toBe('https://containers.example.test/api/health');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'GET', redirect: 'error', signal: expect.any(AbortSignal), headers: { Authorization: 'Bearer private-token' },
    });
  });

  it('preserves an explicitly registered HTTP probe without issuing protocol requests', async () => {
    const request = vi.fn();
    const health = vi.fn(async () => true);
    const provider = new RemoteContainerSandboxProvider(createRemoteContainerHttpTransport({ request, health }));
    await expect(createRemoteContainerPlugin(provider).health!()).resolves.toMatchObject({ status: 'healthy' });
    expect(health).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['throw', 'invalid-response', 'unauthorized'] as const)('contains configured HTTP failures without exposing secrets (%s)', async failure => {
    const fetch = vi.fn(async () => {
      if (failure === 'throw') throw new Error('Bearer private-token https://user:password@example.test');
      return new Response(JSON.stringify({ healthy: 'private-token' }), {
        status: failure === 'unauthorized' ? 401 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const [plugin] = await createConfiguredPlugins({
      configurations: [{ id: 'sandbox.remote-container', config: {
        transport: 'http', endpoint: 'https://containers.example.test/api', token: { env: 'TOKEN' },
      } }],
      environment: { TOKEN: 'private-token' }, fetch,
    });
    const runtime = new PluginRuntime();
    await runtime.activate(plugin);
    await expect(runtime.health()).resolves.toEqual([{
      pluginId: 'sandbox.remote-container', status: 'unhealthy', message: 'Remote container health probe failed',
    }]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('bounds configured HTTP health with the existing transport timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<Parameters<typeof globalThis.fetch>, Promise<Response>>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      }));
      const [plugin] = await createConfiguredPlugins({
        configurations: [{ id: 'sandbox.remote-container', config: {
          transport: 'http', endpoint: 'https://containers.example.test/api', timeoutMs: 1234,
        } }], fetch,
      });
      const runtime = new PluginRuntime();
      await runtime.activate(plugin);
      const result = runtime.health();
      await vi.advanceTimersByTimeAsync(1233);
      expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject([{
        status: 'unhealthy', message: 'Remote container health probe failed',
      }]);
      expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
