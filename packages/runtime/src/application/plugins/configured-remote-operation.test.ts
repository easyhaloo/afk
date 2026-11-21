import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredPlugins, getConfiguredCredentialDependencies, inspectConfiguredPlugins } from './configured.js';
import { PluginRuntime } from './runtime.js';
import type { CredentialValue, ProviderOperationOptions, RepositoryProvider } from '../../plugin-sdk/capabilities.js';
import { RemoteWorkspaceProvider } from '../../infrastructure/providers/repositories.js';
import { createRemoteContainerHttpTransport, type RemoteRequestOptions, type RemoteContainerSandboxProvider } from '../../infrastructure/sandbox/remote-container.js';
import type { ConfiguredPluginsOptions } from './configured.js';

const kinds = ['sandbox.remote-container', 'repository.remote-workspace'] as const;
const ref = { provider: 'named.remote', name: 'remote-token', scope: 'remote:operate' };
const runtimes: PluginRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(kind: typeof kinds[number], extraRef = {}) {
  const runtime = new PluginRuntime(); runtimes.push(runtime);
  const resolve = vi.fn(async (_ref: unknown, _options?: ProviderOperationOptions): Promise<CredentialValue> => ({ secret: 'first' }));
  await runtime.activate({
    manifest: { id: 'credential.remote', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
    activate(context) {
      context.registerCredentialProvider(ref.provider, { id: ref.provider, capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve });
    },
  });
  const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit): Promise<Response> => Response.json(kind === kinds[0]
    ? { iid: 1, path: '/remote', branch: 'main', healthy: true }
    : { commit: 'a'.repeat(40), branch: 'main', dirty: false }));
  const config: NonNullable<ConfiguredPluginsOptions['configurations'][number]['config']> = kind === kinds[0]
    ? { transport: 'http', endpoint: 'https://remote.example/api', token: { ...ref, ...extraRef }, timeoutMs: 1000 }
    : { baseUrl: 'https://remote.example/api', token: { ...ref, ...extraRef } };
  const [metadata] = inspectConfiguredPlugins({ configurations: [{ id: kind, config }], environment: {} });
  expect(metadata.credentialDependencies).toEqual([ref.provider]);
  const [plugin] = await createConfiguredPlugins({ configurations: [{ id: kind, config }], fetch: transport });
  await runtime.activate(plugin);
  const provider = kind === kinds[0] ? runtime.getSandboxProvider('remote-container')! : runtime.getRepositoryProvider('remote-workspace')!;
  const operate = () => kind === kinds[0]
    ? runtime.getSandboxProvider('remote-container')!.createWorktree({ iid: 1, baseBranch: 'main' })
    : (provider as RepositoryProvider).snapshot({ url: 'team/repo with space' });
  const used = () => transport.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
  return { runtime, plugin, provider, resolve, transport, operate, used };
}

describe.each(kinds)('remote operation credentials: %s', kind => {
  it('keeps discovery, activation, list and doctor lazy and retains the exact credential owner', async () => {
    const f = await fixture(kind);
    f.runtime.listPlugins(); f.runtime.listProvidersForPlugin(kind); await f.plugin.diagnostics?.(); await f.runtime.diagnostics();
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    expect(getConfiguredCredentialDependencies(f.plugin)).toEqual([ref.provider]);
    await expect(f.runtime.dispose('credential.remote')).rejects.toThrow('required');
    await f.operate(); f.resolve.mockResolvedValue({ secret: 'rotated' }); await f.operate();
    expect(f.used()).toEqual(['Bearer first', 'Bearer rotated']);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.resolve.mock.calls[0][0]).toEqual({ name: ref.name, scope: ref.scope });
    if (kind === kinds[1]) expect(String(f.transport.mock.calls[0][0])).toBe('https://remote.example/api/workspaces/team%2Frepo%20with%20space/snapshot');
  });

  it.each([
    { secret: '' }, { secret: ' ' }, { secret: 'bad\rvalue' }, { secret: 3 }, null,
    { secret: 'expired', expiresAt: '2000-01-01T00:00:00Z' },
    { secret: 'bad-date', expiresAt: 'tomorrow' }, { secret: 'bad-expiry', expiresAt: 42 },
    { secret: 'revoked', revoked: true }, { secret: 'bad-revocation', revoked: 'yes' },
  ])('rejects original invalid metadata after a prior success: %j', async value => {
    const f = await fixture(kind); await f.operate();
    f.resolve.mockResolvedValue(value as CredentialValue);
    await expect(f.operate()).rejects.toThrow(/^Operation credential unavailable$/);
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('uses exact offset-aware expiry and configured reference expiry on each request', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const f = await fixture(kind, { expiresAt: '2026-11-15T08:00:01+08:00' });
    f.resolve.mockResolvedValue({ secret: 'live', expiresAt: '2026-11-15T00:00:02Z', revoked: false });
    await f.operate(); vi.advanceTimersByTime(1000);
    await expect(f.operate()).rejects.toThrow(/^Operation credential unavailable$/);
    expect(f.resolve).toHaveBeenCalledTimes(1); expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('isolates overlapping resolutions and never reuses the previous request token', async () => {
    const f = await fixture(kind); const a = deferred<CredentialValue>(); const b = deferred<CredentialValue>();
    f.resolve.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const first = f.operate(); const second = f.operate();
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(2));
    b.resolve({ secret: 'second' }); await second; a.resolve({ secret: 'first' }); await first;
    expect(f.used()).toEqual(['Bearer second', 'Bearer first']);
  });

  it.each(['resolution', 'http'] as const)('rejects disposal during %s and prevents later use', async phase => {
    const f = await fixture(kind); const credential = deferred<CredentialValue>(); const response = deferred<Response>();
    if (phase === 'resolution') f.resolve.mockImplementationOnce(() => credential.promise);
    else f.transport.mockImplementationOnce(() => response.promise);
    const outcome = f.operate().then(() => 'success', () => 'rejected');
    await vi.waitFor(() => expect(phase === 'resolution' ? f.resolve : f.transport).toHaveBeenCalledTimes(1));
    await f.runtime.dispose(kind); await f.runtime.dispose('credential.remote');
    await expect(outcome).resolves.toBe('rejected');
    credential.resolve({ secret: 'late' }); response.resolve(Response.json({ iid: 1, path: '/remote', branch: 'main', commit: 'a', dirty: false }));
    await Promise.resolve();
    if (phase === 'resolution') expect(f.transport).not.toHaveBeenCalled();
    const old = kind === kinds[0]
      ? () => (f.provider as RemoteContainerSandboxProvider).createWorktree({ iid: 1, baseBranch: 'main' })
      : () => (f.provider as RepositoryProvider).snapshot({ url: 'repo' });
    await expect(old()).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(phase === 'resolution' ? 0 : 1);
  });

  it('contains credential and HTTP errors without leaking cause, body or abort details', async () => {
    const f = await fixture(kind);
    f.resolve.mockRejectedValueOnce(new Error('remote-token private-resolver-detail'));
    await expect(f.operate()).rejects.toThrow(/^Operation credential unavailable$/);
    f.resolve.mockResolvedValue({ secret: 'rotated-private' });
    f.transport.mockRejectedValueOnce(new Error('rotated-private remote-token'));
    const error = await f.operate().then(() => undefined, error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/rotated-private|remote-token/);
    f.transport.mockResolvedValueOnce(new Response('rotated-private', { status: 402 }));
    await expect(f.operate()).rejects.toThrow(/402/);
    expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it('keeps an old operation invalid across disposal and reactivation', async () => {
    const f = await fixture(kind); const credential = deferred<CredentialValue>();
    f.resolve.mockImplementationOnce(() => credential.promise);
    const old = f.operate().then(() => 'success', () => 'rejected');
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
    await f.runtime.dispose(kind); await f.runtime.activate(f.plugin);
    const current = kind === kinds[0]
      ? f.runtime.getSandboxProvider('remote-container')!.createWorktree({ iid: 1, baseBranch: 'main' })
      : f.runtime.getRepositoryProvider('remote-workspace')!.snapshot({ url: 'repo' });
    await current; credential.resolve({ secret: 'old-activation' });
    expect(await old).toBe('rejected'); expect(f.used()).toEqual(['Bearer first']);
  });

  it('keeps environment capture at configuration time', async () => {
    const environment = { TOKEN: 'environment-first' };
    const config: NonNullable<ConfiguredPluginsOptions['configurations'][number]['config']> = kind === kinds[0]
      ? { transport: 'http', endpoint: 'https://remote.example/api', token: { env: 'TOKEN' } }
      : { baseUrl: 'https://remote.example/api', token: { env: 'TOKEN' } };
    expect(inspectConfiguredPlugins({ configurations: [{ id: kind, config }], environment: {} })[0].credentialDependencies).toEqual([]);
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json({ iid: 1, path: '/remote', commit: 'a', branch: 'main', dirty: false }));
    const [plugin] = await createConfiguredPlugins({ configurations: [{ id: kind, config }], environment, fetch: transport });
    environment.TOKEN = 'environment-later';
    const runtime = new PluginRuntime(); runtimes.push(runtime); await runtime.activate(plugin);
    if (kind === kinds[0]) await runtime.getSandboxProvider('remote-container')!.createWorktree({ iid: 1, baseBranch: 'main' });
    else await runtime.getRepositoryProvider('remote-workspace')!.snapshot({ url: 'repo' });
    expect(new Headers(transport.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer environment-first');
  });
});

function direct(kind: typeof kinds[number], token: (options?: ProviderOperationOptions) => Promise<CredentialValue>, transport: typeof fetch) {
  if (kind === kinds[0]) {
    const remote = createRemoteContainerHttpTransport({ baseUrl: 'https://remote.example/api', token, fetch: transport, timeoutMs: 100 });
    return { operate: (options?: RemoteRequestOptions) => remote.request('sandbox.close', { sandboxId: 'sandbox' }, options), dispose: () => remote.dispose?.() };
  }
  const remote = new RemoteWorkspaceProvider({ baseUrl: 'https://remote.example/api', token, transport });
  return { operate: (options?: ProviderOperationOptions) => remote.snapshot({ url: 'repo' }, options), dispose: () => remote.dispose() };
}

describe.each(kinds)('remote request boundaries: %s', kind => {
  it('includes credential resolution in the existing default HTTP timeout', async () => {
    vi.useFakeTimers(); const credential = deferred<CredentialValue>(); const transport = vi.fn();
    const f = direct(kind, () => credential.promise, transport);
    const outcome = f.operate().then(() => 'success', () => 'rejected');
    await vi.advanceTimersByTimeAsync(kind === kinds[0] ? 100 : 15_000);
    expect(await outcome).toBe('rejected'); credential.resolve({ secret: 'late' }); await vi.advanceTimersByTimeAsync(0);
    expect(transport).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['abort', 'dispose'] as const)('settles an abort-ignoring HTTP fetch on %s without leaking details', async mode => {
    vi.useFakeTimers(); const response = deferred<Response>(); const controller = new AbortController();
    const transport = vi.fn((_url: Parameters<typeof fetch>[0], _init?: RequestInit) => response.promise);
    const f = direct(kind, async () => ({ secret: 'rotated-private' }), transport);
    const outcome = f.operate({ signal: controller.signal }).then(() => 'success', error => String(error));
    await vi.advanceTimersByTimeAsync(0); expect(transport).toHaveBeenCalledOnce();
    if (mode === 'abort') controller.abort(new Error('rotated-private remote-token'));
    else f.dispose();
    expect(await outcome).not.toMatch(/success|rotated-private|remote-token/);
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    response.resolve(Response.json({ ok: true, commit: 'a', branch: 'main', dirty: false })); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['abort', 'deadline', 'dispose'] as const)('settles a blocked resolver on %s without sending its late credential', async mode => {
    vi.useFakeTimers(); const credential = deferred<CredentialValue>();
    const resolve = vi.fn((_options?: ProviderOperationOptions) => credential.promise);
    const transport = vi.fn(async () => Response.json({ ok: true, commit: 'a', branch: 'main', dirty: false }));
    const f = direct(kind, resolve, transport); const controller = new AbortController(); const deadlineAt = Date.now() + 30;
    const outcome = f.operate({ signal: controller.signal, deadlineAt }).then(() => 'success', error => (error as Error).message);
    await vi.advanceTimersByTimeAsync(0); expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0][0]?.deadlineAt).toBe(deadlineAt);
    expect(resolve.mock.calls[0][0]?.signal).toBeInstanceOf(AbortSignal);
    if (mode === 'abort') controller.abort(new Error('private-abort-detail'));
    else if (mode === 'deadline') await vi.advanceTimersByTimeAsync(30);
    else f.dispose();
    expect(await outcome).not.toMatch(/success|private-abort-detail/);
    credential.resolve({ secret: 'late-secret' }); await vi.advanceTimersByTimeAsync(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('covers resolution and an abort-ignoring HTTP fetch with one remaining deadline', async () => {
    vi.useFakeTimers(); const credential = deferred<CredentialValue>(); const response = deferred<Response>();
    const resolve = vi.fn(() => credential.promise); const transport = vi.fn((_url: Parameters<typeof fetch>[0], _init?: RequestInit) => response.promise);
    const f = direct(kind, resolve, transport);
    const outcome = f.operate({ deadlineAt: Date.now() + 80 }).then(() => 'success', () => 'rejected');
    await vi.advanceTimersByTimeAsync(50); credential.resolve({ secret: 'live' }); await vi.advanceTimersByTimeAsync(0);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30); expect(await outcome).toBe('rejected');
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    response.resolve(Response.json({ ok: true, commit: 'a', branch: 'main', dirty: false })); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds body consumption by credential expiry and ignores late body success', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-type': 'application/json' } }));
    const f = direct(kind, async () => ({ secret: 'live', expiresAt: new Date(Date.now() + 25).toISOString() }), transport);
    const outcome = f.operate().then(() => 'success', () => 'rejected');
    await vi.advanceTimersByTimeAsync(25); expect(await outcome).toBe('rejected');
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resolve for already cancelled or expired requests', async () => {
    const resolve = vi.fn(async () => ({ secret: 'unused' })); const transport = vi.fn(); const f = direct(kind, resolve, transport);
    const controller = new AbortController(); controller.abort(new Error('private-cancel-detail'));
    await expect(f.operate({ signal: controller.signal })).rejects.toThrow();
    await expect(f.operate({ deadlineAt: Date.now() - 1 })).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
});

it('keeps the configured container active health probe fresh, bounded and scoped to health', async () => {
  const f = await fixture(kinds[0]);
  await expect(f.plugin.health?.()).resolves.toMatchObject({ status: 'healthy', message: expect.stringMatching(/execution readiness was not checked/) });
  f.resolve.mockResolvedValue({ secret: 'health-rotated' }); await f.plugin.health?.();
  expect(f.used()).toEqual(['Bearer first', 'Bearer health-rotated']);
  expect(f.transport.mock.calls.every(([url, init]) => String(url) === 'https://remote.example/api/health' && init?.method === 'GET')).toBe(true);
});

it('bounds an active health credential resolution and rejects revoked health credentials', async () => {
  vi.useFakeTimers(); const f = await fixture(kinds[0]); const credential = deferred<CredentialValue>();
  f.resolve.mockImplementationOnce(() => credential.promise);
  const outcome = f.plugin.health!(); await vi.advanceTimersByTimeAsync(1000);
  await expect(outcome).resolves.toMatchObject({ status: 'unhealthy' });
  credential.resolve({ secret: 'late' }); await vi.advanceTimersByTimeAsync(0);
  f.resolve.mockResolvedValue({ secret: 'revoked', revoked: true });
  await expect(f.plugin.health!()).resolves.toMatchObject({ status: 'unhealthy' });
  expect(f.transport).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('resolves anew for each remote lifecycle HTTP request, including publish and cleanup snapshots', async () => {
  let token = 0; const resolve = vi.fn(async () => ({ secret: `token-${++token}` }));
  const request = { repository: { url: 'repo', ref: 'main' }, runId: 'run-1' };
  const snapshot = { commit: 'a'.repeat(40), branch: 'afk/run-1', dirty: false };
  const workspace = { id: 'workspace-1', ...request, snapshot };
  const transport = vi.fn(async (url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const operation = String(url).split('/').at(-1);
    return Response.json(operation === 'prepare' || operation === 'checkout' ? workspace
      : operation === 'snapshot' ? snapshot : operation === 'publish' ? { commit: snapshot.commit, branch: snapshot.branch }
        : { removed: true });
  });
  const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://remote.example/api', token: resolve, transport,
    lifecycle: { repositories: [request.repository], operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
  await provider.prepare(request); await provider.checkout({ workspaceId: workspace.id });
  await provider.publish({ workspaceId: workspace.id }); await provider.cleanup({ workspaceId: workspace.id });
  expect(transport.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['prepare', 'checkout', 'snapshot', 'publish', 'snapshot', 'cleanup']);
  expect(transport.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual(Array.from({ length: 6 }, (_, index) => `Bearer token-${index + 1}`));
  expect(resolve).toHaveBeenCalledTimes(6); provider.dispose();
});

it.each(['prepare', 'checkout', 'publish', 'cleanup'] as const)('contains cancellation before remote lifecycle %s reaches HTTP', async operation => {
  const resolve = vi.fn(async () => ({ secret: 'unused' })); const transport = vi.fn();
  const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://remote.example/api', token: resolve, transport,
    lifecycle: { repositories: [{ url: 'repo' }], operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
  const controller = new AbortController(); controller.abort(new Error('remote-token private-cancellation'));
  const outcome = operation === 'prepare'
    ? provider.prepare({ repository: { url: 'repo' }, runId: 'run-1' }, { signal: controller.signal })
    : provider[operation]({ workspaceId: 'workspace-1' }, { signal: controller.signal });
  const error = await outcome.then(() => undefined, error => error as Error);
  expect(error).toBeInstanceOf(Error); expect(String(error)).not.toMatch(/remote-token|private-cancellation/);
  expect(resolve).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); provider.dispose();
});
