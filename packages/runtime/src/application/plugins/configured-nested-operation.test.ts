import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredPlugins, inspectConfiguredPlugins } from './configured.js';
import { PluginRuntime } from './runtime.js';
import type { CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';

const kinds = ['credential.oauth', 'credential.enterprise'] as const;
const reference = { provider: 'nested.fixture', name: 'upstream', scope: 'client:read' };
const runtimes: PluginRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.useRealTimers(); });

async function fixture(kind: typeof kinds[number], extraReference = {}) {
  const runtime = new PluginRuntime(); runtimes.push(runtime);
  const resolve = vi.fn(async (_ref: unknown, _options?: ProviderOperationOptions): Promise<CredentialValue> => ({ secret: 'first' }));
  await runtime.activate({
    manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
    activate(context) {
      context.registerCredentialProvider(reference.provider, {
        id: reference.provider, capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve,
      });
    },
  });
  const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json({ access_token: 'issued', token_type: 'Bearer' }));
  const ref = { ...reference, ...extraReference };
  const config: PluginConfigValue = kind === 'credential.oauth'
    ? { tokenEndpoint: 'https://auth.example.test/token', clientId: 'client', clientSecret: ref }
    : { values: { deployment: ref } };
  const [plugin] = await createConfiguredPlugins({ configurations: [{ id: kind, config }], fetch: transport });
  await runtime.activate(plugin);
  return { runtime, resolve, transport, plugin, config, provider: runtime.getCredentialProvider(kind)! };
}

describe.each(kinds)('nested operation credential: %s', kind => {
  it('reserves its exact upstream before first use', async () => {
    const f = await fixture(kind);
    expect(f.resolve).not.toHaveBeenCalled();
    await expect(f.runtime.dispose('credential.fixture')).rejects.toThrow('required');
    expect(f.runtime.getCredentialProvider(reference.provider)).toBeDefined();
  });

  it('keeps metadata and activation passive, resolves every operation, and observes rotation', async () => {
    const f = await fixture(kind);
    expect(inspectConfiguredPlugins({ configurations: [{ id: kind, config: f.config }] })[0].credentialDependencies).toEqual([reference.provider]);
    await f.plugin.health?.(); await f.plugin.diagnostics?.();
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    await f.provider.resolve({ name: 'deployment' });
    f.resolve.mockResolvedValue({ secret: 'second', expiresAt: '2099-01-01T00:00:00Z' });
    const second = await f.provider.resolve({ name: 'deployment' });
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.resolve.mock.calls[0][0]).toEqual({ name: reference.name, scope: reference.scope });
    if (kind === 'credential.enterprise') expect(second).toEqual({ secret: 'second', expiresAt: '2099-01-01T00:00:00Z' });
    else expect(f.transport.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual([
      `Basic ${Buffer.from('client:first').toString('base64')}`,
      `Basic ${Buffer.from('client:second').toString('base64')}`,
    ]);
  });

  it.each([
    { secret: 'expired', expiresAt: '2000-01-01T00:00:00Z' },
    { secret: 'revoked', revoked: true },
  ])('refuses invalid upstream credentials after a successful operation: %j', async value => {
    const f = await fixture(kind); await f.provider.resolve({ name: 'deployment' });
    f.resolve.mockResolvedValue(value);
    await expect(f.provider.resolve({ name: 'deployment' })).rejects.toThrow('Operation credential unavailable');
    expect(f.transport).toHaveBeenCalledTimes(kind === 'credential.oauth' ? 1 : 0);
  });

  it('checks configured reference expiry before resolving or posting', async () => {
    const f = await fixture(kind, { expiresAt: '2000-01-01T00:00:00+00:00' });
    await expect(f.provider.resolve({ name: 'deployment' })).rejects.toThrow('Operation credential unavailable');
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(['2099-01-01', '2099-01-01T00:00:00', '2099-01-01T00:00:00+99:99'])('validates original upstream metadata before capping expiry: %s', async expiresAt => {
    const f = await fixture(kind, { expiresAt: '2098-01-01T00:00:00Z' });
    f.resolve.mockResolvedValue({ secret: 'invalid-metadata', expiresAt });
    await expect(f.provider.resolve({ name: 'deployment' })).rejects.toThrow('Operation credential unavailable');
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('rejects reference expiry with an out-of-range timezone', async () => {
    await expect(fixture(kind, { expiresAt: '2099-01-01T00:00:00+99:99' })).rejects.toThrow('invalid configuration fields');
  });

  it('forwards operation cancellation and suppresses an uncooperative late upstream value', async () => {
    const f = await fixture(kind); const controller = new AbortController();
    let finish!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const deadlineAt = Date.now() + 10000;
    const pending = f.provider.resolve({ name: 'deployment' }, { signal: controller.signal, deadlineAt });
    const outcome = expect(pending).rejects.toThrow('Operation credential unavailable');
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
    expect(f.resolve.mock.calls[0][1]).toEqual({ signal: controller.signal, deadlineAt });
    controller.abort(new Error('private upstream failure')); await outcome;
    finish({ secret: 'late' }); await Promise.resolve();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('rejects resolution started under a disposed activation', async () => {
    const f = await fixture(kind);
    let finish!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const outcome = f.provider.resolve({ name: 'deployment' }).then(() => 'accepted', () => 'rejected');
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
    await f.runtime.dispose(kind); finish({ secret: 'late' });
    expect(await outcome).toBe('rejected'); expect(f.transport).not.toHaveBeenCalled();
  });

  it('enforces an absolute deadline while upstream resolution is pending', async () => {
    vi.useFakeTimers(); const f = await fixture(kind);
    f.resolve.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = f.provider.resolve({ name: 'deployment' }, { deadlineAt: Date.now() + 20 });
    const outcome = expect(pending).rejects.toThrow('Operation credential unavailable');
    await vi.advanceTimersByTimeAsync(20); await outcome;
    expect(f.transport).not.toHaveBeenCalled();
  });
});

it.each([undefined, '2099-01-01T00:00:00Z', '2097-01-01T00:00:00Z'])('preserves the earlier reference or upstream expiry for enterprise forwarding: %s', async expiresAt => {
  const f = await fixture('credential.enterprise', { expiresAt: '2098-01-01T00:00:00Z' });
  f.resolve.mockResolvedValue({ secret: 'forwarded', ...(expiresAt ? { expiresAt } : {}) });
  await expect(f.provider.resolve({ name: 'deployment' })).resolves.toEqual({
    secret: 'forwarded', expiresAt: expiresAt === '2097-01-01T00:00:00Z' ? expiresAt : '2098-01-01T00:00:00Z',
  });
});
