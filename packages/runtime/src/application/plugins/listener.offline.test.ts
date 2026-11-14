import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startPluginListener, pluginTriggerQueue } from './listener.js';
import { PluginRuntime } from './runtime.js';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { DurableTriggerQueue, currentTriggerDeliveryId } from './trigger-queue.js';
import { GitPushTriggerProvider, WebhookTriggerProvider } from '../../infrastructure/providers/triggers.js';

const http = vi.hoisted(() => ({ handler: undefined as undefined | ((request: IncomingMessage, response: ServerResponse) => void), fail: false, beforeReady: undefined as undefined | (() => void) }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { createServer: (_options: unknown, handler: typeof http.handler) => {
    http.handler = handler;
    const server = new EventEmitter();
    return Object.assign(server, {
      listen(_port: number, _host: string, ready: () => void) { http.beforeReady?.(); queueMicrotask(() => http.fail ? server.emit('error', new Error('EADDRINUSE')) : ready()); },
      address: () => ({ address: '127.0.0.1', port: 0, family: 'IPv4' }),
      close(done: () => void) { done(); },
      closeAllConnections() {},
    });
  } };
});

const token = 'offline-listener-secret';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  http.fail = false;
  http.beforeReady = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function queuePath() {
  const directory = mkdtempSync(join(tmpdir(), 'afk-listener-offline-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'queue.sqlite');
}

async function request(path: string, body = '{}', headers: { [name: string]: string } = { authorization: `Bearer ${token}` }, method = 'POST') {
  let status = 0;
  let finish!: (body: string) => void;
  const response = new Promise<string>(resolve => { finish = resolve; });
  const incoming = Object.assign(Readable.from([Buffer.from(body)]), { url: path, method, headers }) as IncomingMessage;
  const outgoing = {
    setHeader() {},
    writeHead(code: number) { status = code; return this; },
    end(value = '') { finish(value); },
    destroy() { finish(''); },
  } as unknown as ServerResponse;
  http.handler!(incoming, outgoing);
  const text = await response;
  return { status, body: text ? JSON.parse(text) : undefined };
}

async function fixture(provider = new GitPushTriggerProvider(), durable = true) {
  const runtime = new PluginRuntime();
  for (const plugin of createBuiltinCapabilityPlugins({ triggers: [provider] })) await runtime.activate(plugin);
  cleanup.push(() => runtime.dispose());
  await provider.register({ id: 'push', kind: 'webhook' });
  const path = durable ? queuePath() : undefined;
  const listener = await startPluginListener(runtime, { token, queuePath: path });
  cleanup.push(() => listener.close().catch(() => {}));
  return { runtime, listener, path };
}

it('uses the already reserved queue before readiness and keeps authenticated webhook receipts and conflicts', async () => {
  vi.useFakeTimers();
  const runtime = new PluginRuntime();
  const ids: Array<string | undefined> = [];
  const provider = new GitPushTriggerProvider({ onPush: () => { ids.push(currentTriggerDeliveryId()); } });
  for (const plugin of createBuiltinCapabilityPlugins({ triggers: [provider] })) await runtime.activate(plugin);
  cleanup.push(() => runtime.dispose());
  await provider.register({ id: 'push', kind: 'webhook' });
  const path = queuePath();
  const queue = pluginTriggerQueue(runtime, { queuePath: path })!;
  http.beforeReady = () => queue.enqueue('trigger.git-push', '{"ref":"early"}', 'early');
  const listener = await startPluginListener(runtime, { token, queuePath: path });
  cleanup.push(() => listener.close());
  expect(listener.queue).toBe(queue);
  expect(queue.storageUsage().records).toBe(1);
  expect(ids).toEqual([]);
  const headers = { authorization: `Bearer ${token}`, 'x-github-delivery': 'delivery' };
  expect((await request('/triggers/trigger.git-push', '{"ref":"main"}', {})).status).toBe(401);
  expect((await request('/triggers/trigger.git-push', '{}')).status).toBe(400);
  const receipt = await request('/triggers/trigger.git-push', '{"ref":"main"}', headers);
  expect(receipt).toMatchObject({ status: 202, body: { duplicate: false, status: 'pending' } });
  expect((await request('/triggers/trigger.git-push', '{"ref":"main"}', headers)).body).toMatchObject({ duplicate: true, deliveryId: receipt.body.deliveryId });
  expect((await request('/triggers/trigger.git-push', '{"ref":"changed"}', headers)).status).toBe(409);
  await vi.advanceTimersByTimeAsync(1);
  expect(ids).toHaveLength(2);
  expect(ids).toContain(receipt.body.deliveryId);
  const status = await request('/deliveries', '', undefined, 'GET');
  expect(status.body.deliveries).toHaveLength(2);
  expect(status.body.deliveries[0]).not.toHaveProperty('body');
});

it('retains the active owner through bounded listener shutdown and leaves queued work for restart', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const active = new Promise<void>(resolve => { finish = resolve; });
  const { runtime, listener, path } = await fixture(new GitPushTriggerProvider({ onPush: async () => active }));
  await request('/triggers/trigger.git-push', '{"ref":"active"}');
  await request('/triggers/trigger.git-push', '{"ref":"queued"}');
  await vi.advanceTimersByTimeAsync(1);
  let failure: unknown;
  void listener.close().catch(error => { failure = error; });
  await vi.advanceTimersByTimeAsync(5000);
  try {
    expect(failure).toBeInstanceOf(Error);
    expect(pluginTriggerQueue(runtime)).toBe(listener.queue);
    expect(() => new DurableTriggerQueue(path!, async () => {})).toThrow('already owned');
    expect(listener.queue!.status().map(row => row.status).sort()).toEqual(['pending', 'processing']);
  } finally { finish(); await listener.queue!.close({ drain: false }); }
  expect(pluginTriggerQueue(runtime)).toBeUndefined();
  const next = new DurableTriggerQueue(path!, async () => {});
  cleanup.push(() => next.close());
  expect(next.status().map(row => row.status).sort()).toEqual(['delivered', 'pending']);
});

it('bounds shutdown for an uncooperative ordinary request', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const active = new Promise<void>(resolve => { finish = resolve; });
  const { listener } = await fixture(new GitPushTriggerProvider({ onPush: async () => active }), false);
  const response = request('/triggers/trigger.git-push', '{"ref":"active"}');
  await vi.advanceTimersByTimeAsync(1);
  let failure: unknown;
  void listener.close().catch(error => { failure = error; });
  await vi.advanceTimersByTimeAsync(5000);
  try { expect(failure).toBeInstanceOf(Error); }
  finally { finish(); await response; }
});

it('releases ownership on bind failure and rejects conflicting runtime paths', async () => {
  const runtime = new PluginRuntime();
  const path = queuePath();
  pluginTriggerQueue(runtime, { queuePath: path });
  expect(() => pluginTriggerQueue(runtime, { queuePath: path + '.other' })).toThrow('differs');
  http.fail = true;
  await expect(startPluginListener(runtime, { token, queuePath: path })).rejects.toThrow('EADDRINUSE');
  expect(pluginTriggerQueue(runtime)).toBeUndefined();
  const owner = new DurableTriggerQueue(path, async () => {});
  await owner.close();
});

it('keeps webhook HMAC authentication and queue capacity responses', async () => {
  vi.useFakeTimers();
  const runtime = new PluginRuntime();
  const provider = new WebhookTriggerProvider({ secret: token });
  for (const plugin of createBuiltinCapabilityPlugins({ triggers: [provider] })) await runtime.activate(plugin);
  cleanup.push(() => runtime.dispose());
  await provider.register({ id: 'hook', kind: 'webhook' });
  const listener = await startPluginListener(runtime, { token, queuePath: queuePath(), queueOptions: { maxRecords: 1 } });
  cleanup.push(() => listener.close());
  const body = '{"event":"push"}';
  expect((await request('/triggers/trigger.webhook', body)).status).toBe(401);
  const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', token).update(body).digest('hex')}`, 'idempotency-key': 'one' };
  expect((await request('/triggers/trigger.webhook', body, headers)).status).toBe(202);
  expect((await request('/triggers/trigger.webhook', body, { ...headers, 'idempotency-key': 'two' })).status).toBe(503);
  expect((await request('/triggers/trigger.webhook', body, headers)).body.duplicate).toBe(true);
  expect((await runtime.diagnostics()).some(row => row.code === 'trigger.queue-full')).toBe(true);
});
