import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredPlugins, getConfiguredCredentialDependencies } from './configured.js';
import { PluginRuntime } from './runtime.js';
import type { CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { ReportPlatformProvider } from '../../infrastructure/providers/artifacts.js';
import { FeishuNotificationProvider, SlackNotificationProvider } from '../../infrastructure/providers/notifications.js';

const kinds = ['artifact.report-platform', 'notification.feishu', 'notification.slack'] as const;
const runtimes: PluginRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
const ref = { provider: 'named.fixture', name: 'private-ref-name', scope: 'delivery:write' };
const artifact = { name: 'report.txt', mediaType: 'text/plain', bytes: new Uint8Array([65]) };

async function fixture(kind: typeof kinds[number], initial: CredentialValue = { secret: 'first' }, extraRef = {}) {
  const runtime = new PluginRuntime(); runtimes.push(runtime);
  const secret = (value: string) => kind === kinds[0] ? value : `https://hooks.example.test/${value}`;
  const resolve = vi.fn(async (_ref: unknown, _options?: ProviderOperationOptions): Promise<CredentialValue> => ({ ...initial, secret: secret(initial.secret) }));
  await runtime.activate({
    manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
    activate(c) {
      c.registerCredentialProvider(ref.provider, { id: ref.provider, capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve });
      c.registerCredentialProvider('wrong', { id: 'wrong', capabilities: { read: true, rotate: false, 'scoped-token': false }, resolve: async () => { throw new Error('wrong provider'); } });
    },
  });
  const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => kind === kinds[0]
    ? Response.json({ uri: 'https://reports.example.test/result' }) : kind === kinds[1] ? Response.json({ code: 0 }) : new Response('ok'));
  const [plugin] = await createConfiguredPlugins({ configurations: [{ id: kind, config: kind === kinds[0]
    ? { endpoint: 'https://reports.example.test/upload', token: { ...ref, ...extraRef } }
    : { webhook: { ...ref, ...extraRef } } }], fetch: transport });
  await runtime.activate(plugin);
  const provider = kind === kinds[0] ? runtime.getArtifactProvider('report-platform')! : runtime.getNotificationProvider(kind)!;
  expect(provider).toBeInstanceOf(kind === kinds[0] ? ReportPlatformProvider : kind === kinds[1] ? FeishuNotificationProvider : SlackNotificationProvider);
  const operate = async (options?: ProviderOperationOptions) => {
    if (kind === kinds[0]) return (provider as ReportPlatformProvider).put(artifact, options);
    const result = await (provider as SlackNotificationProvider).notify({ title: 'Build', body: 'Passed' }, options);
    if (!result.delivered) throw new Error(result.error);
    return result;
  };
  const used = () => transport.mock.calls.map(([url, init]) => kind === kinds[0] ? new Headers(init?.headers).get('authorization') : String(url));
  return { runtime, resolve, transport, plugin, operate, used, secret, provider };
}

describe.each(kinds)('ordinary operation credentials: %s', kind => {
  it('reserves the exact upstream before first use even with another credential provider', async () => {
    const f = await fixture(kind);
    await f.runtime.activate({
      manifest: { id: 'credential.alternative', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
      activate(context) {
        context.registerCredentialProvider('alternative', { id: 'alternative', capabilities: { read: true, rotate: false, 'scoped-token': false }, resolve: async () => ({ secret: 'unused' }) });
      },
    });
    expect(f.resolve).not.toHaveBeenCalled();
    await expect(f.runtime.dispose('credential.fixture')).rejects.toThrow('required');
    expect(f.runtime.getCredentialProvider(ref.provider)).toBeDefined();
  });

  it('keeps activation/list/health/doctor passive, then resolves the named scoped reference for each operation', async () => {
    const f = await fixture(kind);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(getConfiguredCredentialDependencies(f.plugin)).toEqual([ref.provider]);
    f.runtime.listPlugins(); f.runtime.listProvidersForPlugin(kind); await f.plugin.health?.(); await f.plugin.diagnostics?.(); await f.runtime.health(); await f.runtime.diagnostics();
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    await f.operate(); f.resolve.mockResolvedValue({ secret: f.secret('rotated') }); await f.operate();
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.resolve.mock.calls[0][0]).toEqual({ name: ref.name, scope: ref.scope });
    expect(f.used()).toEqual(kind === kinds[0] ? ['Bearer first', 'Bearer rotated'] : [f.secret('first'), f.secret('rotated')]);
  });

  it.each([{ secret: '' }, { secret: '   ' }, { secret: 'bad\nvalue' }, { secret: 42 }, null,
    { secret: 'expired', expiresAt: '2000-01-01T00:00:00Z' }, { secret: 'invalid-date', expiresAt: 'tomorrow' },
    { secret: 'revoked', revoked: true }, { secret: 'bad-revocation', revoked: 'yes' },
  ])('fails closed after a prior success for ordinary result %j', async value => {
    const f = await fixture(kind); await f.operate();
    f.resolve.mockResolvedValue(value as CredentialValue);
    await expect(f.operate()).rejects.toThrow('Operation credential unavailable');
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('checks exact offset-aware expiry on every operation and configured reference expiry before resolution', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    const f = await fixture(kind); f.resolve.mockResolvedValue({ secret: f.secret('live'), expiresAt: '2026-11-14T08:00:01+08:00' });
    await f.operate(); vi.setSystemTime(new Date('2026-11-14T00:00:01Z'));
    await expect(f.operate()).rejects.toThrow('Operation credential unavailable');
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.resolve).toHaveBeenCalledTimes(2);
    const g = await fixture(kind, { secret: 'first' }, { expiresAt: '2026-11-14T00:00:02Z' });
    await g.operate(); vi.setSystemTime(new Date('2026-11-14T00:00:02Z'));
    await expect(g.operate()).rejects.toThrow('Operation credential unavailable'); expect(g.resolve).toHaveBeenCalledTimes(1);
  });

  it('isolates overlapping operations without a shared cached token', async () => {
    const f = await fixture(kind);
    let finishA!: (v: CredentialValue) => void; let finishB!: (v: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finishA = done; })).mockImplementationOnce(() => new Promise(done => { finishB = done; }));
    const a = f.operate(); const b = f.operate(); await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(2));
    finishB({ secret: f.secret('second') }); await b; finishA({ secret: f.secret('first') }); await a;
    expect(f.used()).toEqual(kind === kinds[0] ? ['Bearer second', 'Bearer first'] : [f.secret('second'), f.secret('first')]);
  });

  it('forwards trusted cancellation and deadline, settles even when resolver ignores abort, and ignores its late value', async () => {
    const f = await fixture(kind); const controller = new AbortController();
    let finish!: (v: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const deadlineAt = Date.now() + 10000;
    const pending = f.operate({ signal: controller.signal, deadlineAt });
    const rejected = expect(pending).rejects.toThrow('Operation credential unavailable');
    void rejected.catch(() => undefined);
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
    expect(f.resolve.mock.calls[0][1]?.signal).toBe(controller.signal); expect(f.resolve.mock.calls[0][1]?.deadlineAt).toBe(deadlineAt);
    controller.abort(new Error('private-abort-detail')); await rejected;
    finish({ secret: f.secret('late-rotated-secret') }); await Promise.resolve();
    expect(f.transport).not.toHaveBeenCalled();
    await expect(f.operate({ signal: controller.signal })).rejects.toThrow(); expect(f.resolve).toHaveBeenCalledTimes(1);
  });

  it('hides cancellation details after resolving a rotated secret at HTTP delivery', async () => {
    const f = await fixture(kind); const controller = new AbortController();
    f.resolve.mockResolvedValue({ secret: f.secret('late-rotated-secret') });
    f.transport.mockImplementationOnce((_url, init) => new Promise((_done, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('late-rotated-secret')), { once: true });
    }));
    const pending = f.operate({ signal: controller.signal });
    const failure = pending.then(() => { throw new Error('Expected cancellation'); }, error => error as Error);
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1));
    controller.abort(new Error(`${ref.name} late-rotated-secret`));
    expect((await failure).message).not.toContain(ref.name);
    expect((await failure).message).not.toContain('late-rotated-secret');
  });

  it('does not reuse a successful credential after consumer and named provider disposal', async () => {
    const f = await fixture(kind); await f.operate();
    await f.runtime.dispose(kind);
    await f.runtime.dispose('credential.fixture');
    await expect(f.operate()).rejects.toThrow(/^Operation credential unavailable$/);
    expect(f.resolve).toHaveBeenCalledTimes(1); expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('keeps an old in-flight resolution invalid after consumer reactivation', async () => {
    const f = await fixture(kind);
    let finish!: (value: CredentialValue) => void;
    f.resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const oldOutcome = f.operate().then(() => 'delivered', () => 'rejected');
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
    await f.runtime.dispose(kind);
    await f.runtime.activate(f.plugin);
    if (kind === kinds[0]) await f.runtime.getArtifactProvider('report-platform')!.put(artifact);
    else expect((await f.runtime.getNotificationProvider(kind)!.notify({ title: 'New', body: 'Activation' })).delivered).toBe(true);
    finish({ secret: f.secret('old-activation-secret') });
    expect(await oldOutcome).toBe('rejected');
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.resolve).toHaveBeenCalledTimes(2);
  });

  it('enforces deadline during credential resolution and after resolution at HTTP transport', async () => {
    vi.useFakeTimers();
    const f = await fixture(kind); f.resolve.mockImplementationOnce(() => new Promise(() => undefined));
    const p = f.operate({ deadlineAt: Date.now() + 20 }); const rejected = expect(p).rejects.toThrow('Operation credential unavailable');
    void rejected.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(20); await rejected; expect(f.transport).not.toHaveBeenCalled();
    f.transport.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('late-rotated-secret')), { once: true }); }));
    const q = f.operate({ deadlineAt: Date.now() + 20 }); const rejectedHttp = expect(q).rejects.toThrow();
    void rejectedHttp.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(20); await rejectedHttp; expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('uses safe failures before resolution and redacts rotated values from later health and doctor', async () => {
    const f = await fixture(kind); f.resolve.mockRejectedValueOnce(new Error(`${ref.name} never-returned-secret`));
    await expect(f.operate()).rejects.toThrow(/^Operation credential unavailable$/);
    f.resolve.mockResolvedValue({ secret: f.secret('late-rotated-secret') }); await f.operate();
    Object.assign(f.provider, { health: async () => ({ status: 'unavailable', message: f.secret('late-rotated-secret') }), doctor: async () => [{ check: f.secret('late-rotated-secret'), ok: false, detail: f.secret('late-rotated-secret') }] });
    const inspection = JSON.stringify([await f.plugin.health?.(), await f.plugin.diagnostics?.()]);
    expect(inspection).not.toContain('late-rotated-secret'); expect(inspection).toContain('[redacted]');
  });
});

it.each(['notification.feishu', 'notification.slack'] as const)('validates every rotated webhook URL for %s', async kind => {
  const f = await fixture(kind); await f.operate();
  for (const secret of ['file:///private', 'https://user:pass@example.test', 'https://hooks.example.test/#private', 'not-a-url']) {
    f.resolve.mockResolvedValue({ secret }); await expect(f.operate()).rejects.toThrow();
  }
  expect(f.transport).toHaveBeenCalledTimes(1);
});
