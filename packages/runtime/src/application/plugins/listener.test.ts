import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { startPluginListener } from './listener.js';
import { PluginRuntime } from './runtime.js';
import { GitPushTriggerProvider, WebhookTriggerProvider } from '../../infrastructure/providers/triggers.js';

const token = 'fixture-trigger-secret-value';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('plugin trigger listener', () => {
  it('waits for an accepted action before completing shutdown', async () => {
    let finish: () => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const provider = new GitPushTriggerProvider({ onPush: async () => { started(); await pending; } });
    const runtime = new PluginRuntime();
    for (const plugin of createBuiltinCapabilityPlugins({ triggers: [provider] })) await runtime.activate(plugin);
    cleanup.push(() => runtime.dispose());
    await provider.register({ id: 'push', kind: 'webhook' });
    const listener = await startPluginListener(runtime, { token, port: 0 });
    cleanup.push(() => listener.close());
    const address = listener.address;
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const request = fetch(`http://127.0.0.1:${address.port}/triggers/${provider.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"ref":"refs/heads/main"}' }).catch(() => undefined);
    await entered;
    let closed = false;
    const stopping = listener.close().then(() => { closed = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally { finish(); await stopping; await request; }
    expect(closed).toBe(true);
    await listener.close();
  });
  it('dispatches authenticated signed events and rejects unauthenticated or malformed requests', async () => {
    const onPush = vi.fn();
    const onEvent = vi.fn();
    const push = new GitPushTriggerProvider({ onPush });
    const webhook = new WebhookTriggerProvider({ secret: token, onEvent });
    const runtime = new PluginRuntime();
    for (const plugin of createBuiltinCapabilityPlugins({ triggers: [push, webhook] })) await runtime.activate(plugin);
    cleanup.push(() => runtime.dispose());
    await push.register({ id: 'push', kind: 'webhook' });
    await webhook.register({ id: 'hook', kind: 'webhook' });
    const listener = await startPluginListener(runtime, { token, port: 0 });
    cleanup.push(() => listener.close());
    const address = listener.address;
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const url = `http://127.0.0.1:${address.port}/triggers/`;
    expect((await fetch(url + push.id, { method: 'POST', body: '{}' })).status).toBe(401);
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', token).update(body).digest('hex')}` };
    expect(await (await fetch(url + push.id, { method: 'POST', headers, body })).json()).toEqual({ dispatched: 1 });
    expect(onPush).toHaveBeenCalledOnce();
    expect((await fetch(url + webhook.id, { method: 'POST', headers, body })).status).toBe(200);
    expect(onEvent).toHaveBeenCalledOnce();
    expect((await fetch(url + push.id, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '[]' })).status).toBe(400);
  });
});
