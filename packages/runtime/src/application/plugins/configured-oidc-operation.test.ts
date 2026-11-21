import { afterEach, expect, it, vi } from 'vitest';
import { createConfiguredPlugins, getConfiguredCredentialDependencies, inspectConfiguredPlugins } from './configured.js';
import { PluginRuntime } from './runtime.js';
import type { CredentialRef, CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { OidcCredentialProvider } from '../../infrastructure/providers/credentials.js';
import type { FetchTransport } from '../../infrastructure/providers/dependencies.js';

const issuer = 'https://oidc.example.test/tenant';
const tokenEndpoint = 'https://token.example.test/exchange';
const assertionRef = { provider: 'named.assertion', name: 'assertion', scope: 'sign' };
const subjectRef = { provider: 'named.subject', name: 'subject', scope: 'exchange' };
const epoch = Date.parse('2026-11-15T00:00:00Z');
const runtimes: PluginRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

function deferred<T>() {
  let finish!: (value: T) => void;
  const promise = new Promise<T>(resolve => { finish = resolve; });
  return { promise, finish };
}

async function fixture(exchange = true, extraRef = {}, timeoutMs = 1000) {
  const runtime = new PluginRuntime(); runtimes.push(runtime);
  const assertion = vi.fn(async (_ref: CredentialRef, _options?: ProviderOperationOptions): Promise<CredentialValue> => ({ secret: 'assertion-one' }));
  const subject = vi.fn(async (_ref: CredentialRef, _options?: ProviderOperationOptions): Promise<CredentialValue> => ({ secret: 'subject-one' }));
  for (const [id, name, resolve] of [['owner.assertion', assertionRef.provider, assertion], ['owner.subject', subjectRef.provider, subject]] as const) {
    await runtime.activate({ manifest: { id, version: '1.0.0', apiVersion: 1, trusted: true, provides: ['credential.provider'] },
      activate(context) { context.registerCredentialProvider(name, { id: name, capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve }); } });
  }
  const transport = vi.fn<Parameters<FetchTransport>, ReturnType<FetchTransport>>(async (_url, init) => init?.method === 'GET'
    ? Response.json({ issuer, token_endpoint: tokenEndpoint })
    : Response.json({ access_token: 'minted', token_type: 'Bearer', expires_in: 60,
      ...(exchange ? { issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' } : {}) }));
  const configurations = [{ id: 'credential.oidc', config: { issuer, clientId: 'client', timeoutMs,
    assertion: { ...assertionRef, ...extraRef }, ...(exchange ? { exchange: { subjectToken: subjectRef, subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt' } } : {}) } }];
  expect(inspectConfiguredPlugins({ configurations })[0].credentialDependencies).toEqual(exchange ? [assertionRef.provider, subjectRef.provider] : [assertionRef.provider]);
  const [plugin] = await createConfiguredPlugins({ configurations, fetch: transport });
  await runtime.activate(plugin);
  const provider = runtime.getCredentialProvider('credential.oidc')!;
  const posts = () => transport.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { runtime, assertion, subject, transport, plugin, provider, posts };
}

it('keeps discovery, validation, activation and diagnostics passive and binds exact owners', async () => {
  const f = await fixture();
  expect(getConfiguredCredentialDependencies(f.plugin)).toEqual([assertionRef.provider, subjectRef.provider]);
  f.runtime.listPlugins(); f.runtime.listProvidersForPlugin('credential.oidc');
  await f.runtime.health(); await f.runtime.diagnostics();
  expect(f.assertion).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  await expect(f.runtime.dispose('owner.assertion')).rejects.toThrow('required');
  await expect(f.runtime.dispose('owner.subject')).rejects.toThrow('required');
});

it.each([false, true])('resolves fresh scoped inputs for every exchange=%s without clamping issued token lifetime', async exchange => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  const f = await fixture(exchange);
  f.assertion.mockResolvedValue({ secret: 'assertion-one', expiresAt: new Date(epoch + 100).toISOString() });
  f.subject.mockResolvedValue({ secret: 'subject-one', expiresAt: new Date(epoch + 200).toISOString() });
  expect(await f.provider.resolve({ name: 'api', scope: 'read' })).toEqual({ secret: 'minted', expiresAt: new Date(epoch + 60000).toISOString() });
  f.assertion.mockResolvedValue({ secret: 'assertion-two' }); f.subject.mockResolvedValue({ secret: 'subject-two' });
  await f.provider.resolve({ name: 'api' });
  expect(f.assertion).toHaveBeenCalledTimes(2); expect(f.subject).toHaveBeenCalledTimes(exchange ? 2 : 0);
  expect(f.assertion.mock.calls[0][0]).toEqual({ name: 'assertion', scope: 'sign' });
  const forms = f.posts().map(([, init]) => new URLSearchParams(String(init?.body)));
  expect(forms.map(form => form.get('client_assertion'))).toEqual(['assertion-one', 'assertion-two']);
  if (exchange) {
    expect(f.subject.mock.calls[0][0]).toEqual({ name: 'subject', scope: 'exchange' });
    expect(forms.map(form => form.get('subject_token'))).toEqual(['subject-one', 'subject-two']);
  }
});

it.each(['assertion', 'subject'] as const)('rejects expired, revoked and invalid ordinary %s results before POST', async source => {
  const f = await fixture();
  await f.provider.resolve({ name: 'api' });
  for (const value of [{ secret: 'private-input', revoked: true }, { secret: 'private-input', expiresAt: '2000-01-01T00:00:00Z' },
    { secret: 'private-input', expiresAt: 'tomorrow' }, { secret: '' }, { secret: 'line\nbreak' }]) {
    f[source].mockResolvedValue(value);
    await expect(f.provider.resolve({ name: 'api' })).rejects.not.toThrow('private-input');
  }
  expect(f.posts()).toHaveLength(1);
});

it('checks configured reference expiry per operation before resolving the named source', async () => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  const f = await fixture(false, { expiresAt: new Date(epoch + 20).toISOString() });
  await f.provider.resolve({ name: 'api' }); vi.setSystemTime(epoch + 20);
  await expect(f.provider.resolve({ name: 'api' })).rejects.toThrow('unavailable');
  expect(f.assertion).toHaveBeenCalledTimes(1); expect(f.posts()).toHaveLength(1);
});

it('rechecks assertion expiry after subject preparation before sending POST', async () => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  const f = await fixture();
  f.assertion.mockResolvedValue({ secret: 'short-assertion', expiresAt: new Date(epoch + 20).toISOString() });
  f.subject.mockImplementation(async () => { vi.setSystemTime(epoch + 20); return { secret: 'subject' }; });
  await expect(f.provider.resolve({ name: 'api' })).rejects.toThrow('unavailable');
  expect(f.posts()).toHaveLength(0);
});

it.each(['assertion', 'subject'] as const)('rejects %s expiry while reading the token body', async source => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  const f = await fixture();
  f[source].mockResolvedValue({ secret: 'short-input', expiresAt: new Date(epoch + 20).toISOString() });
  const body = deferred<void>();
  f.transport.mockImplementation(async (_url, init) => init?.method === 'GET' ? Response.json({ issuer, token_endpoint: tokenEndpoint })
    : new Response(new ReadableStream({ async start(controller) { await body.promise; controller.enqueue(new TextEncoder().encode('{"access_token":"minted","token_type":"Bearer","issued_token_type":"urn:ietf:params:oauth:token-type:access_token"}')); controller.close(); } })));
  const outcome = f.provider.resolve({ name: 'api' }).then(() => 'accepted', () => 'rejected');
  await vi.advanceTimersByTimeAsync(0); expect(f.posts()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20); body.finish();
  expect(await outcome).toBe('rejected');
});

it('forwards caller cancellation and absolute deadline and ignores late preparation', async () => {
  const f = await fixture(); const controller = new AbortController(); const waiting = deferred<CredentialValue>();
  f.assertion.mockReturnValue(waiting.promise);
  const deadlineAt = Date.now() + 500;
  const outcome = f.provider.resolve({ name: 'api' }, { signal: controller.signal, deadlineAt }).then(() => 'accepted', () => 'rejected');
  await vi.waitFor(() => expect(f.assertion).toHaveBeenCalledTimes(1));
  const options = f.assertion.mock.calls[0][1]!;
  expect(options.deadlineAt).toBe(deadlineAt); expect(options.signal?.aborted).toBe(false);
  controller.abort(); expect(await outcome).toBe('rejected'); expect(options.signal?.aborted).toBe(true);
  waiting.finish({ secret: 'late-assertion' }); await Promise.resolve();
  expect(f.posts()).toHaveLength(0); expect(f.subject).not.toHaveBeenCalled();
});

it.each(['discovery', 'assertion', 'subject', 'body'] as const)('bounds %s by the same total operation budget', async stage => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  const f = await fixture(true, {}, 100);
  f.transport.mockImplementation(async (_url, init) => {
    if (init?.method === 'GET') { await new Promise(resolve => setTimeout(resolve, stage === 'discovery' ? 200 : 40)); return Response.json({ issuer, token_endpoint: tokenEndpoint }); }
    return new Response(new ReadableStream({ start() {} }));
  });
  if (stage === 'assertion') f.assertion.mockImplementation(() => new Promise(() => undefined));
  if (stage === 'subject') f.subject.mockImplementation(() => new Promise(() => undefined));
  const outcome = f.provider.resolve({ name: 'api' }).then(() => 'accepted', () => 'rejected');
  await vi.advanceTimersByTimeAsync(99);
  expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toBe('rejected');
  if (stage !== 'discovery') expect(f.assertion.mock.calls[0][1]?.deadlineAt).toBe(epoch + 100);
  expect(f.posts()).toHaveLength(stage === 'body' ? 1 : 0);
});

it.each(['assertion', 'subject', 'body'] as const)('disposes pending %s and keeps old references dead after reactivation', async stage => {
  const f = await fixture(); const waiting = deferred<CredentialValue>();
  if (stage !== 'body') f[stage].mockReturnValueOnce(waiting.promise);
  else f.transport.mockImplementation(async (_url, init) => init?.method === 'GET' ? Response.json({ issuer, token_endpoint: tokenEndpoint }) : new Response(new ReadableStream({ start() {} })));
  const outcome = f.provider.resolve({ name: 'api' }).then(() => 'accepted', () => 'rejected');
  await vi.waitFor(() => expect(stage === 'body' ? f.posts().length : f[stage].mock.calls.length).toBe(1));
  await f.runtime.dispose('credential.oidc');
  expect(await outcome).toBe('rejected');
  waiting.finish({ secret: 'late-old-value' });
  await f.runtime.activate(f.plugin);
  await expect(f.provider.resolve({ name: 'api' })).rejects.toThrow();
  if (stage !== 'body') await expect(f.runtime.getCredentialProvider('credential.oidc')!.resolve({ name: 'api' })).resolves.toMatchObject({ secret: 'minted' });
});

it('isolates overlapping OIDC preparations and does not cache either input', async () => {
  const f = await fixture(false); const a = deferred<CredentialValue>(); const b = deferred<CredentialValue>();
  f.assertion.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first = f.provider.resolve({ name: 'api' }); const second = f.provider.resolve({ name: 'api' });
  await vi.waitFor(() => expect(f.assertion).toHaveBeenCalledTimes(2));
  b.finish({ secret: 'second' }); await second; a.finish({ secret: 'first' }); await first;
  expect(f.posts().map(([, init]) => new URLSearchParams(String(init?.body)).get('client_assertion'))).toEqual(['second', 'first']);
});

it('captures env-only values at construction and mixed values again during dependency preparation', async () => {
  const environment = { ASSERTION: 'env-before' }; const transport = vi.fn<Parameters<FetchTransport>, ReturnType<FetchTransport>>(async (_url, init) => init?.method === 'GET'
    ? Response.json({ issuer, token_endpoint: tokenEndpoint }) : Response.json({ access_token: 'minted', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }));
  for (const mixed of [false, true]) {
    const runtime = new PluginRuntime(); runtimes.push(runtime); environment.ASSERTION = 'env-before';
    await runtime.activate({ manifest: { id: 'subject.owner', apiVersion: 1, version: '1.0.0', trusted: true, provides: ['credential.provider'] },
      activate(context) { context.registerCredentialProvider(subjectRef.provider, { id: subjectRef.provider, capabilities: { read: true, rotate: false, 'scoped-token': false }, resolve: async () => ({ secret: 'subject' }) }); } });
    const [plugin] = await createConfiguredPlugins({ environment, fetch: transport, configurations: [{ id: 'credential.oidc', config: { issuer, clientId: 'client', assertion: { env: 'ASSERTION' },
      ...(mixed ? { exchange: { subjectToken: subjectRef, subjectTokenType: 'jwt' } } : {}) } }] });
    environment.ASSERTION = 'env-activation'; await runtime.activate(plugin); environment.ASSERTION = 'env-after';
    const old = runtime.getCredentialProvider('credential.oidc')!;
    await old.resolve({ name: 'api' });
    expect(new URLSearchParams(String(transport.mock.calls.at(-1)?.[1]?.body)).get('client_assertion')).toBe(mixed ? 'env-activation' : 'env-before');
    await runtime.dispose('credential.oidc'); environment.ASSERTION = 'env-reactivation'; await runtime.activate(plugin);
    await expect(old.resolve({ name: 'api' })).rejects.toThrow('unavailable');
    await runtime.getCredentialProvider('credential.oidc')!.resolve({ name: 'api' });
    expect(new URLSearchParams(String(transport.mock.calls.at(-1)?.[1]?.body)).get('client_assertion')).toBe(mixed ? 'env-reactivation' : 'env-before');
  }
});

it('preserves direct string and legacy callbacks while supporting optional operation options and metadata', async () => {
  const transport: FetchTransport = async (_url, init) => init?.method === 'GET' ? Response.json({ issuer, token_endpoint: tokenEndpoint })
    : Response.json({ access_token: 'minted', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' });
  const deadlineAt = Date.now() + 1000;
  const assertion = vi.fn((_ref: CredentialRef, endpoint: string, options?: ProviderOperationOptions) => {
    expect(endpoint).toBe(tokenEndpoint); expect(options?.deadlineAt).toBe(deadlineAt); return { secret: 'assertion' };
  });
  const subject = vi.fn((_ref: CredentialRef, options?: ProviderOperationOptions) => { expect(options?.deadlineAt).toBe(deadlineAt); return { secret: 'subject' }; });
  const provider = new OidcCredentialProvider({ issuer, clientId: 'client', fetch: transport, assertion, exchange: { subjectToken: subject, subjectTokenType: 'jwt' } });
  expect(await provider.resolve({ name: 'api' }, { deadlineAt })).toEqual({ secret: 'minted' });
});

it.each(['before', 'preparation', 'body'] as const)('sanitizes caller cancellation %s without leaking credential details', async stage => {
  const f = await fixture(false); const controller = new AbortController();
  if (stage === 'before') controller.abort(new Error('private-caller-detail'));
  if (stage === 'preparation') f.assertion.mockImplementation(() => new Promise(() => undefined));
  if (stage === 'body') f.transport.mockImplementation(async (_url, init) => init?.method === 'GET' ? Response.json({ issuer, token_endpoint: tokenEndpoint }) : new Response(new ReadableStream({ start() {} })));
  const failure = f.provider.resolve({ name: 'api' }, { signal: controller.signal }).then(() => 'accepted', error => (error as Error).message);
  if (stage !== 'before') {
    await vi.waitFor(() => expect(stage === 'preparation' ? f.assertion.mock.calls.length : f.posts().length).toBe(1));
    controller.abort(new Error('private-caller-detail'));
  }
  expect(await failure).not.toContain('private-caller-detail');
  expect(await failure).not.toBe('accepted');
});

it('does not reset a configured budget longer than the HTTP default', async () => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  const f = await fixture(false, {}, 30000);
  f.transport.mockImplementation(async (_url, init) => {
    if (init?.method === 'GET') { await new Promise(resolve => setTimeout(resolve, 16000)); return Response.json({ issuer, token_endpoint: tokenEndpoint }); }
    return Response.json({ access_token: 'minted', token_type: 'Bearer' });
  });
  const outcome = f.provider.resolve({ name: 'api' }).then(value => value.secret, () => 'rejected');
  await vi.advanceTimersByTimeAsync(16000); expect(await outcome).toBe('minted');
});

it('bounds ignored direct callbacks by the default budget without caller options', async () => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  const transport = vi.fn(async () => Response.json({ issuer, token_endpoint: tokenEndpoint }));
  const provider = new OidcCredentialProvider({ issuer, clientId: 'client', fetch: transport, assertion: () => new Promise(() => undefined) });
  const outcome = provider.resolve({ name: 'api' }).then(() => 'accepted', () => 'rejected');
  await vi.advanceTimersByTimeAsync(15000); expect(await outcome).toBe('rejected');
  expect(transport).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('settles disposal during discovery and ignores a late discovery response', async () => {
  const f = await fixture(); const waiting = deferred<Response>(); f.transport.mockReturnValueOnce(waiting.promise);
  const outcome = f.provider.resolve({ name: 'api' }).then(() => 'accepted', () => 'rejected');
  await f.runtime.dispose('credential.oidc'); expect(await outcome).toBe('rejected');
  waiting.finish(Response.json({ issuer, token_endpoint: tokenEndpoint })); await Promise.resolve();
  expect(f.assertion).not.toHaveBeenCalled(); expect(f.posts()).toHaveLength(0);
});

it.each([NaN, Infinity, 1.5, epoch])('rejects invalid or expired caller deadline %s before any discovery or preparation', async deadlineAt => {
  const f = await fixture();
  await expect(f.provider.resolve({ name: 'api' }, { deadlineAt })).rejects.toThrow('deadline');
  expect(f.assertion).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
});

it.each([
  {}, { access_token: 'minted', token_type: 'DPoP' }, { access_token: 'minted', token_type: 'Bearer', expires_in: 0 },
  { access_token: 'minted', token_type: 'Bearer', expires_in: '60' },
  { access_token: 'minted', token_type: 'Bearer', scope: 'other' },
  { access_token: 'minted', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:id_token' },
])('retains token-exchange response validation for ordinary payload %j', async payload => {
  const f = await fixture();
  f.transport.mockImplementation(async (_url, init) => init?.method === 'GET' ? Response.json({ issuer, token_endpoint: tokenEndpoint }) : Response.json(payload));
  await expect(f.provider.resolve({ name: 'api', scope: 'read' })).rejects.toThrow('Credential endpoint');
  expect(f.posts()).toHaveLength(1);
});
