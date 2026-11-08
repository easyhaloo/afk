import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { startPluginListener } from './listener.js';
import { PluginRuntime } from './runtime.js';
import { GitPushTriggerProvider, IssueEventTriggerProvider, WebhookTriggerProvider } from '../../infrastructure/providers/triggers.js';
import { openSqlite } from '../../infrastructure/storage/sqlite.js';
import { currentTriggerDeliveryId } from './trigger-queue.js';

const token = 'fixture-trigger-secret-value';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function durablePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'afk-listener-queue-'));
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'triggers.sqlite');
}

async function listen(providers: Array<GitPushTriggerProvider | WebhookTriggerProvider | IssueEventTriggerProvider>, options: Partial<Parameters<typeof startPluginListener>[1]> = {}) {
  const runtime = new PluginRuntime();
  for (const plugin of createBuiltinCapabilityPlugins({ triggers: providers })) await runtime.activate(plugin);
  cleanup.push(() => runtime.dispose());
  for (const provider of providers) await provider.register({ id: provider.id, kind: 'webhook' });
  const listener = await startPluginListener(runtime, { token, port: 0, ...options });
  cleanup.push(() => listener.close());
  const address = listener.address;
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const url = `http://127.0.0.1:${address.port}`;
  const send = (providerId: string, body: string, headers: Record<string, string> = { authorization: `Bearer ${options.token ?? token}` }) =>
    fetch(`${url}/triggers/${providerId}`, { method: 'POST', headers, body });
  return { listener, runtime, send, url };
}

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
    const onPush = vi.fn(() => { expect(currentTriggerDeliveryId()).toBeUndefined(); });
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
    expect(listener.queue).toBeUndefined();
    const address = listener.address;
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const url = `http://127.0.0.1:${address.port}/triggers/`;
    expect((await fetch(url + push.id, { method: 'POST', body: '{}' })).status).toBe(401);
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', token).update(body).digest('hex')}` };
    expect(await (await fetch(url + push.id, { method: 'POST', headers, body })).json()).toEqual({ dispatched: 1 });
    expect(onPush).toHaveBeenCalledOnce();
    expect(currentTriggerDeliveryId()).toBeUndefined();
    expect((await fetch(url + webhook.id, { method: 'POST', headers, body })).status).toBe(200);
    expect(onEvent).toHaveBeenCalledOnce();
    expect((await fetch(url + push.id, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '[]' })).status).toBe(400);
  });

  it('returns a durable receipt before action completion, deduplicates retries, and drains on close', async () => {
    const queuePath = durablePath();
    let finish: () => void = () => {};
    let enter: () => void = () => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const onPush = vi.fn(async () => { enter(); await pending; });
    const provider = new GitPushTriggerProvider({ onPush });
    const { listener, send } = await listen([provider], { queuePath });
    const body = '{"ref":"refs/heads/main"}';
    const headers = { authorization: `Bearer ${token}`, 'x-github-delivery': 'github-delivery-1' };
    let stopping: Promise<void> | undefined;
    try {
      const response = await send(provider.id, body, headers);
      expect(response.status).toBe(202);
      const receipt = await response.json();
      expect(receipt).toMatchObject({ duplicate: false, status: 'pending', attempts: 0 });
      await entered;
      const connection = openSqlite({ file: queuePath, schema: '', version: 2 });
      try { expect(connection.prepare('SELECT deliveryId, body FROM trigger_deliveries').get()).toEqual({ deliveryId: receipt.deliveryId, body }); }
      finally { connection.close(); }
      expect(await (await send(provider.id, body, headers)).json()).toMatchObject({ deliveryId: receipt.deliveryId, duplicate: true });
      expect((await send(provider.id, '{"ref":"other"}', headers)).status).toBe(409);
      expect(onPush).toHaveBeenCalledOnce();
      let closed = false;
      stopping = listener.close().then(() => { closed = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally { finish(); await stopping; }
    await listener.close();
    expect(onPush).toHaveBeenCalledOnce();
  });

  it('retries failed actions and keeps delivery status across listener restarts', async () => {
    const queuePath = durablePath();
    const observedIds: Array<string | undefined> = [];
    const onPush = vi.fn(async (payload: unknown) => {
      expect(payload).toEqual({ ref: 'main' });
      const deliveryId = currentTriggerDeliveryId();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(currentTriggerDeliveryId()).toBe(deliveryId);
      observedIds.push(deliveryId);
      if (observedIds.length === 1) throw new Error('transient');
    });
    const first = await listen([new GitPushTriggerProvider({ onPush })], { queuePath, queueOptions: { retryDelayMs: 1, maxAttempts: 2 } });
    const response = await first.send('trigger.git-push', '{"ref":"main"}', { 'x-gitlab-token': token, 'x-gitlab-event-uuid': 'gitlab-delivery-1' });
    expect(response.status).toBe(202);
    const receipt = await response.json();
    await vi.waitFor(() => expect(first.listener.queue!.status(receipt.deliveryId)[0]).toMatchObject({ status: 'delivered', attempts: 2 }));
    await first.listener.close();
    const restarted = await listen([new GitPushTriggerProvider({ onPush })], { queuePath });
    const duplicate = await restarted.send('trigger.git-push', '{"ref":"main"}', { 'x-gitlab-token': token, 'x-gitlab-event-uuid': 'gitlab-delivery-1' });
    expect(await duplicate.json()).toMatchObject({ deliveryId: receipt.deliveryId, duplicate: true, status: 'delivered' });
    expect(onPush).toHaveBeenCalledTimes(2);
    expect(observedIds).toEqual([receipt.deliveryId, receipt.deliveryId]);
    expect(currentTriggerDeliveryId()).toBeUndefined();
  });

  it('returns 503 at storage capacity while retaining receipts and accepting duplicates', async () => {
    const queuePath = durablePath();
    const onPush = vi.fn();
    const { listener, send } = await listen([new GitPushTriggerProvider({ onPush })], { queuePath, queueOptions: { maxRecords: 1 } });
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'one' };
    const accepted = await send('trigger.git-push', '{"ref":"main"}', headers);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    await vi.waitFor(() => expect(listener.queue!.status(receipt.deliveryId)[0].status).toBe('delivered'));
    const refused = await send('trigger.git-push', '{"ref":"other"}');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'Trigger queue is full' });
    const duplicate = await send('trigger.git-push', '{"ref":"main"}', headers);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, deliveryId: receipt.deliveryId });
    expect(listener.queue!.storageUsage()).toMatchObject({ records: 1 });
    expect(listener.queue!.pruneDelivered()).toBe(0);
    expect(onPush).toHaveBeenCalledOnce();
  });

  it('authenticates queue status and replay through the owning listener without exposing payloads', async () => {
    let fail = true;
    const ids: Array<string | undefined> = [];
    const onPush = vi.fn(async () => {
      ids.push(currentTriggerDeliveryId());
      if (fail) throw new Error('transient');
    });
    const { listener, send, url } = await listen([new GitPushTriggerProvider({ onPush })], { queuePath: durablePath(), queueOptions: { maxAttempts: 1 } });
    const body = '{"ref":"main","private":"payload-only"}';
    const receipt = await (await send('trigger.git-push', body)).json();
    await vi.waitFor(() => expect(listener.queue!.status(receipt.deliveryId)[0].status).toBe('failed'));
    const replayPath = `/deliveries/${receipt.deliveryId}/replay`;
    const unauthenticatedHeaders: Array<Record<string, string>> = [{}, { authorization: 'Bearer invalid' }, { 'x-gitlab-token': token }];
    for (const [method, path] of [['GET', '/deliveries'], ['GET', '/deliveries?offset=100&limit=100'], ['POST', replayPath], ['POST', '/deliveries/prune']]) {
      for (const headers of unauthenticatedHeaders) {
        expect((await fetch(url + path, { method, headers })).status).toBe(401);
      }
    }
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(`${url}/deliveries`, { headers });
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({ deliveries: [{ deliveryId: receipt.deliveryId, status: 'failed', attempts: 1 }], storage: { records: 1, bytes: Buffer.byteLength(body) } });
    expect(status.deliveries[0]).not.toHaveProperty('body');
    expect(JSON.stringify(status)).not.toContain('payload-only');
    expect(JSON.stringify(status)).not.toContain(token);
    expect((await fetch(`${url}/deliveries/${'0'.repeat(64)}/replay`, { method: 'POST', headers })).status).toBe(404);
    expect((await fetch(`${url}/deliveries/invalid/replay`, { method: 'POST', headers })).status).toBe(404);
    expect((await fetch(`${url}/deliveries`, { method: 'POST', headers })).status).toBe(404);
    expect((await fetch(url + replayPath, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect(listener.queue!.status(receipt.deliveryId)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    fail = false;
    const replayed = await fetch(url + replayPath, { method: 'POST', headers });
    expect(replayed.status).toBe(202);
    expect(await replayed.json()).toMatchObject({ deliveryId: receipt.deliveryId, status: 'pending', attempts: 0 });
    await vi.waitFor(() => expect(listener.queue!.status(receipt.deliveryId)[0].status).toBe('delivered'));
    expect(ids).toEqual([receipt.deliveryId, receipt.deliveryId]);
    expect((await fetch(url + replayPath, { method: 'POST', headers })).status).toBe(409);
    expect(onPush).toHaveBeenCalledTimes(2);
  });

  it('exposes older failed deliveries on subsequent bounded status pages', async () => {
    let fail = true;
    const { listener, send, url } = await listen([new GitPushTriggerProvider({ onPush: async () => { if (fail) throw new Error('retry later'); } })], { queuePath: durablePath(), queueOptions: { maxAttempts: 1 } });
    const failed = await (await send('trigger.git-push', '{"ref":"old"}')).json();
    await vi.waitFor(() => expect(listener.queue!.status(failed.deliveryId)[0].status).toBe('failed'));
    fail = false;
    for (let index = 0; index < 100; index++) {
      expect((await send('trigger.git-push', JSON.stringify({ ref: `new-${index}` }))).status).toBe(202);
    }
    const headers = { authorization: `Bearer ${token}` };
    const firstResponse = await fetch(`${url}/deliveries`, { headers });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first).toMatchObject({ offset: 0, limit: 100, nextOffset: 100, storage: { records: 101 } });
    expect(first.deliveries).toHaveLength(100);
    expect(first.deliveries.some((delivery: { deliveryId: string }) => delivery.deliveryId === failed.deliveryId)).toBe(false);
    const secondResponse = await fetch(`${url}/deliveries?offset=${first.nextOffset}&limit=100`, { headers });
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({ offset: 100, limit: 100, nextOffset: null, deliveries: [{ deliveryId: failed.deliveryId, status: 'failed' }] });
    const empty = await fetch(`${url}/deliveries?offset=101&limit=1`, { headers });
    expect(await empty.json()).toMatchObject({ deliveries: [], nextOffset: null });
    const single = await fetch(`${url}/deliveries?offset=0&limit=1`, { headers });
    expect(await single.json()).toMatchObject({ limit: 1, nextOffset: 1 });
    for (const query of ['offset=-1', 'offset=1.5', 'offset=9007199254740992', 'offset=', 'limit=0', 'limit=101', 'limit=NaN', 'limit=1.5', 'offset=0&offset=1', 'limit=1&limit=2']) {
      const response = await fetch(`${url}/deliveries?${query}`, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid delivery pagination' });
    }
  });

  it('prunes expired delivered receipts through a bounded authenticated request and frees queue capacity', async () => {
    const queuePath = durablePath();
    let fail = false;
    const { listener, send, url } = await listen([new GitPushTriggerProvider({ onPush: async () => { if (fail) throw new Error('retry later'); } })], { queuePath, queueOptions: { maxRecords: 2, maxAttempts: 1 } });
    const delivered = await (await send('trigger.git-push', '{"ref":"main"}')).json();
    await vi.waitFor(() => expect(listener.queue!.status(delivered.deliveryId)[0].status).toBe('delivered'));
    fail = true;
    const failed = await (await send('trigger.git-push', '{"ref":"failed"}')).json();
    await vi.waitFor(() => expect(listener.queue!.status(failed.deliveryId)[0].status).toBe('failed'));
    expect((await send('trigger.git-push', '{"ref":"next"}')).status).toBe(503);
    const headers = { authorization: `Bearer ${token}` };
    const prune = () => fetch(`${url}/deliveries/prune`, { method: 'POST', headers });
    const retained = await prune();
    expect(retained.status).toBe(200);
    expect(await retained.json()).toEqual({ removed: 0 });
    const connection = openSqlite({ file: queuePath, schema: '', version: 2 });
    try { connection.exec('UPDATE trigger_deliveries SET deliveredAt = 0'); }
    finally { connection.close(); }
    const pruneDelivered = vi.spyOn(listener.queue!, 'pruneDelivered');
    try {
      expect((await fetch(`${url}/deliveries/prune`, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
      expect(pruneDelivered).not.toHaveBeenCalled();
      expect((await fetch(`${url}/deliveries/prune`, { headers })).status).toBe(404);
      const response = await prune();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removed: 1 });
      expect(pruneDelivered).toHaveBeenCalledOnce();
    } finally { pruneDelivered.mockRestore(); }
    expect(listener.queue!.status(delivered.deliveryId)).toEqual([]);
    expect(listener.queue!.status(failed.deliveryId)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(listener.queue!.storageUsage()).toMatchObject({ records: 1 });
    expect(await (await prune()).json()).toEqual({ removed: 0 });
    expect((await send('trigger.git-push', '{"ref":"next"}')).status).toBe(202);
  });

  it('returns authenticated 503 responses for queue operations when storage is not configured', async () => {
    const { listener, url } = await listen([new GitPushTriggerProvider()]);
    expect(listener.queue).toBeUndefined();
    for (const [method, path] of [['GET', '/deliveries'], ['POST', `/deliveries/${'0'.repeat(64)}/replay`], ['POST', '/deliveries/prune']]) {
      expect((await fetch(url + path, { method })).status).toBe(401);
      const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Durable trigger queue is not configured' });
    }
  });

  it('reports queue operation failures without exposing internal errors', async () => {
    const { listener, send, url } = await listen([new GitPushTriggerProvider({ onPush: async () => { throw new Error('retry later'); } })], { queuePath: durablePath(), queueOptions: { maxAttempts: 1 } });
    const receipt = await (await send('trigger.git-push', '{"ref":"main"}')).json();
    await vi.waitFor(() => expect(listener.queue!.status(receipt.deliveryId)[0].status).toBe('failed'));
    const status = vi.spyOn(listener.queue!, 'status').mockImplementation(() => { throw new Error('internal-secret-detail'); });
    try {
      for (const [method, path] of [['GET', '/deliveries'], ['POST', `/deliveries/${'0'.repeat(64)}/replay`]]) {
        const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Trigger queue operation failed' });
      }
    } finally { status.mockRestore(); }
    const replay = vi.spyOn(listener.queue!, 'replay').mockImplementation(() => { throw new Error('internal-secret-detail'); });
    try {
      const response = await fetch(`${url}/deliveries/${receipt.deliveryId}/replay`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Trigger queue operation failed' });
      expect(listener.queue!.status(receipt.deliveryId)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    } finally { replay.mockRestore(); }
    const pruneDelivered = vi.spyOn(listener.queue!, 'pruneDelivered').mockImplementation(() => { throw new Error('internal-secret-detail'); });
    try {
      const response = await fetch(`${url}/deliveries/prune`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Trigger queue operation failed' });
      expect(listener.queue!.status(receipt.deliveryId)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    } finally { pruneDelivered.mockRestore(); }
  });

  it('validates authentication, provider schemas and structural limits before storing anything', async () => {
    const queuePath = durablePath();
    const onPush = vi.fn();
    const onEvent = vi.fn();
    const onIssue = vi.fn();
    const { listener, send, runtime } = await listen([
      new GitPushTriggerProvider({ onPush }),
      new WebhookTriggerProvider({ secret: token, onEvent }),
      new IssueEventTriggerProvider({ onIssue }),
    ], { queuePath });
    const diagnostic = vi.spyOn(runtime, 'recordDiagnostic');
    expect((await send('trigger.git-push', '{malformed', {})).status).toBe(401);
    expect((await send('trigger.git-push', '{malformed', { authorization: 'Bearer invalid' })).status).toBe(401);
    expect(diagnostic).not.toHaveBeenCalled();
    const invalid = ['{', 'null', '[]', '{}', '{"ref":""}', '{"ref":"main","deleted":"yes"}', '{"ref":"main","pusher":[]}'];
    for (const body of invalid) expect((await send('trigger.git-push', body)).status).toBe(400);
    expect((await send('trigger.issue-event', '{"action":"opened","issue":{"labels":[1]}}')).status).toBe(400);
    const malformedWebhook = '{"event":false}';
    const signature = `sha256=${createHmac('sha256', token).update(malformedWebhook).digest('hex')}`;
    expect((await send('trigger.webhook', malformedWebhook, { 'x-hub-signature-256': signature })).status).toBe(400);
    expect((await send('trigger.webhook', '{}')).status).toBe(401);
    expect((await send('trigger.git-push', '{"ref":"main"}', { authorization: `Bearer ${token}`, 'x-hub-signature-256': 'invalid', 'idempotency-key': 'bad id' })).status).toBe(400);
    const wide = JSON.stringify({ ref: 'main', data: Array(10_001).fill(0) });
    expect((await send('trigger.git-push', wide)).status).toBe(400);
    const deep = '{"ref":"main","nested":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}';
    expect((await send('trigger.git-push', deep)).status).toBe(400);
    const oversized = JSON.stringify({ ref: 'main', data: 'x'.repeat(1024 * 1024) });
    expect((await send('trigger.git-push', oversized)).status).toBe(413);
    expect(listener.queue!.status()).toEqual([]);
    expect(onPush).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onIssue).not.toHaveBeenCalled();
  });

  it('rejects with 503 and does not dispatch when a durable receipt cannot be written', async () => {
    const queuePath = durablePath();
    const onPush = vi.fn();
    const { listener, send } = await listen([new GitPushTriggerProvider({ onPush })], { queuePath });
    const connection = openSqlite({ file: queuePath, schema: '', version: 2 });
    try { connection.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON trigger_deliveries BEGIN SELECT RAISE(ABORT, 'disk full'); END"); }
    finally { connection.close(); }
    expect((await send('trigger.git-push', '{"ref":"main"}')).status).toBe(503);
    expect(listener.queue!.status()).toEqual([]);
    await listener.close();
    expect(onPush).not.toHaveBeenCalled();
  });

  it('recovers authenticated webhooks after secret rotation without storing tokens or signatures', async () => {
    const queuePath = durablePath();
    const providerSecret = 'provider-secret-separate-from-listener';
    const body = '{"event":"push","payload":{"ref":"main"}}';
    const signature = `sha256=${createHmac('sha256', providerSecret).update(body).digest('hex')}`;
    const first = await listen([new WebhookTriggerProvider({ secret: providerSecret, onEvent: async () => { throw new Error(token); } })], { queuePath, queueOptions: { retryDelayMs: 60_000 } });
    const response = await first.send('trigger.webhook', body, { authorization: `Bearer ${token}`, 'x-hub-signature-256': signature, 'idempotency-key': 'rotated-delivery' });
    expect(response.status).toBe(202);
    const receipt = await response.json();
    await vi.waitFor(() => expect(first.listener.queue!.status(receipt.deliveryId)[0]).toMatchObject({ status: 'pending', attempts: 1 }));
    await first.listener.close();
    const connection = openSqlite({ file: queuePath, schema: '', version: 2 });
    try { connection.exec('UPDATE trigger_deliveries SET nextAttemptAt = 0'); }
    finally { connection.close(); }
    const onEvent = vi.fn();
    const next = await listen([new WebhookTriggerProvider({ secret: 'new-provider-secret', onEvent })], { queuePath, token: 'new-listener-secret-value' });
    await vi.waitFor(() => expect(next.listener.queue!.status(receipt.deliveryId)[0]).toMatchObject({ status: 'delivered', attempts: 2 }));
    expect(onEvent).toHaveBeenCalledWith({ name: 'push', payload: { ref: 'main' } }, expect.anything());
    for (const filename of readdirSync(dirname(queuePath))) {
      const bytes = readFileSync(join(dirname(queuePath), filename));
      for (const secret of [token, providerSecret, signature, 'rotated-delivery', 'new-listener-secret-value']) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it('releases queue ownership when the HTTP listener cannot bind', async () => {
    const queuePath = durablePath();
    const existing = await listen([new GitPushTriggerProvider()]);
    const address = existing.listener.address;
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    await expect(startPluginListener(existing.runtime, { token, port: address.port, queuePath })).rejects.toThrow('EADDRINUSE');
    const restarted = await listen([new GitPushTriggerProvider()], { queuePath });
    expect(restarted.listener.queue!.status()).toEqual([]);
  });
});
