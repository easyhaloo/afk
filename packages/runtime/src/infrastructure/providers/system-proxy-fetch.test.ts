import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvHttpProxyAgent } from 'undici';
import { executeCommand } from './dependencies.js';
import { macProxySettings } from './system-proxy-fetch.js';

vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: () => 'darwin' }));
vi.mock('undici', () => ({ EnvHttpProxyAgent: vi.fn(function () {}) }));
vi.mock('./dependencies.js', () => ({ executeCommand: vi.fn() }));

const systemProxy = `
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
}`;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(name, '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Google system proxy transport', () => {
  it('parses enabled macOS proxies and rejects malformed proxy addresses', () => {
    expect(macProxySettings(systemProxy)).toEqual({ httpProxy: 'http://127.0.0.1:7890/', httpsProxy: 'http://127.0.0.1:7890/' });
    expect(macProxySettings('HTTPEnable : 0\nHTTPSEnable : 0')).toEqual({});
    expect(() => macProxySettings(systemProxy.replaceAll('7890', '70000'))).toThrow('Invalid');
    expect(() => macProxySettings(systemProxy.replaceAll('127.0.0.1', 'user:secret@proxy.example'))).toThrow('Invalid');
    expect(() => macProxySettings('SOCKSEnable : 1')).toThrow('HTTP proxy');
  });

  it('uses existing system proxy settings without changing global dispatchers or exposing secrets', async () => {
    vi.mocked(executeCommand).mockResolvedValue({ stdout: systemProxy, stderr: '' });
    const transport = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', transport);
    const { systemProxyFetch } = await import('./system-proxy-fetch.js');
    expect(await (await systemProxyFetch('https://oauth2.googleapis.com/token')).text()).toBe('ok');
    await systemProxyFetch('https://openidconnect.googleapis.com/v1/userinfo');
    expect(executeCommand).toHaveBeenCalledOnce();
    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({ httpProxy: 'http://127.0.0.1:7890/', httpsProxy: 'http://127.0.0.1:7890/', noProxy: 'localhost,127.0.0.1,[::1]' });
    expect(transport.mock.calls[0][1]).toHaveProperty('dispatcher');
  });

  it('prioritizes explicit proxy environment settings and preserves the NO_PROXY wildcard', async () => {
    vi.stubEnv('https_proxy', 'http://proxy.example:8080');
    vi.stubEnv('no_proxy', '*');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    const { systemProxyFetch } = await import('./system-proxy-fetch.js');
    await systemProxyFetch('https://example.test');
    expect(executeCommand).not.toHaveBeenCalled();
    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({ httpProxy: '', httpsProxy: 'http://proxy.example:8080', noProxy: '*' });
  });

  it('uses direct fetch when no proxy is configured and keeps native errors private', async () => {
    vi.mocked(executeCommand).mockResolvedValue({ stdout: 'HTTPEnable : 0\nHTTPSEnable : 0', stderr: '' });
    const transport = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', transport);
    const direct = await import('./system-proxy-fetch.js');
    await direct.systemProxyFetch('https://example.test');
    expect(transport.mock.calls[0][1]).toBeUndefined();
    expect(EnvHttpProxyAgent).not.toHaveBeenCalled();
    vi.resetModules();
    vi.mocked(executeCommand).mockRejectedValue(new Error('SYNTHETIC_SECRET_ERROR'));
    const unavailable = await import('./system-proxy-fetch.js');
    await expect(unavailable.systemProxyFetch('https://example.test')).rejects.toThrow('Google HTTP proxy configuration is unavailable');
  });
});
