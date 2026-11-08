import { platform } from 'node:os';
import { EnvHttpProxyAgent } from 'undici';
import { executeCommand, type FetchTransport } from './dependencies.js';

export function macProxySettings(text: string): { httpProxy: string | undefined; httpsProxy: string | undefined } {
  const values = Object.fromEntries([...text.matchAll(/^\s*(\w+)\s*:\s*(.+)$/gm)].map(match => [match[1], match[2]]));
  const endpoint = (prefix: 'HTTP' | 'HTTPS'): string | undefined => {
    if (values[`${prefix}Enable`] !== '1') return undefined;
    const host = values[`${prefix}Proxy`];
    const port = Number(values[`${prefix}Port`]);
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid macOS HTTP proxy configuration');
    return new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`).toString();
  };
  const settings = { httpProxy: endpoint('HTTP'), httpsProxy: endpoint('HTTPS') };
  if (!settings.httpProxy && !settings.httpsProxy && (values.ProxyAutoConfigEnable === '1' || values.SOCKSEnable === '1')) {
    throw new Error('Google authentication needs an HTTP proxy; configure HTTPS_PROXY for PAC or SOCKS-only environments');
  }
  return settings;
}

async function proxyDispatcher(): Promise<EnvHttpProxyAgent | undefined> {
  const environment = process.env;
  let settings = { httpProxy: environment.http_proxy ?? environment.HTTP_PROXY, httpsProxy: environment.https_proxy ?? environment.HTTPS_PROXY };
  if (!settings.httpProxy && !settings.httpsProxy && platform() === 'darwin') {
    settings = macProxySettings((await executeCommand({ command: 'scutil', args: ['--proxy'] })).stdout);
  }
  if (!settings.httpProxy && !settings.httpsProxy) return undefined;
  const bypass = environment.no_proxy ?? environment.NO_PROXY ?? '';
  return new EnvHttpProxyAgent({ ...settings, noProxy: bypass.trim() === '*' ? '*' : [bypass, 'localhost', '127.0.0.1', '[::1]'].filter(Boolean).join(',') });
}

// ponytail: cache proxy discovery for this process; restart the client after changing system proxy settings.
let dispatcher: Promise<EnvHttpProxyAgent | undefined> | undefined;

export const systemProxyFetch: FetchTransport = async (input, init) => {
  const selected = await (dispatcher ??= proxyDispatcher().catch(() => { throw new Error('Google HTTP proxy configuration is unavailable'); }));
  return globalThis.fetch(input, selected ? { ...init, dispatcher: selected } as RequestInit : init);
};
