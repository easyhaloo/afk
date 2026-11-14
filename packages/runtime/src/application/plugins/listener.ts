import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { z } from 'zod';
import { WebhookTriggerProvider, GitPushTriggerProvider, IssueEventTriggerProvider } from '../../infrastructure/providers/triggers.js';
import type { PluginRuntime } from './runtime.js';
import { DurableTriggerQueue, InvalidTriggerDelivery, TriggerDeliveryConflict, TriggerQueueFull, type TriggerQueueOptions } from './trigger-queue.js';

export interface PluginListenerOptions {
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly queuePath?: string;
  readonly queueOptions?: TriggerQueueOptions;
  readonly warn?: (message: string) => void;
}

const runtimeQueues = new WeakMap<PluginRuntime, { path: string; queue: DurableTriggerQueue }>();
const scheduledDelivery = z.object({
  action: z.string().min(1), input: z.unknown(), triggerId: z.string().min(1),
  tick: z.object({ id: z.string().min(1), scheduledAt: z.number().int().nonnegative() }).strict(),
}).strict();

export function pluginTriggerQueue(runtime: PluginRuntime, options: Pick<PluginListenerOptions, 'queuePath' | 'queueOptions' | 'warn'> = {}): DurableTriggerQueue | undefined {
  const existing = runtimeQueues.get(runtime);
  if (existing) {
    if (options.queuePath !== undefined && resolve(options.queuePath) !== existing.path) throw new Error('Runtime trigger queue path differs from listener queue path');
    return existing.queue;
  }
  if (options.queuePath === undefined) return undefined;
  const queue = new DurableTriggerQueue(options.queuePath, async delivery => {
    const payload = parsePayload(Buffer.from(delivery.body));
    if (delivery.providerId === 'trigger.schedule') {
      const scheduled = scheduledDelivery.parse(payload);
      try { await runtime.dispatchSystemAction(scheduled.action, scheduled.input); }
      catch {
        runtime.recordDiagnostic({ pluginId: delivery.providerId, severity: 'error', code: 'trigger.action-failed', message: 'Configured trigger action failed' });
        try { options.warn?.(`Trigger action failed for ${delivery.providerId}`); } catch {}
        throw new Error('Configured trigger action failed');
      }
      return;
    }
    const provider = runtime.getTriggerProvider(delivery.providerId);
    if (provider instanceof WebhookTriggerProvider) await provider.handleAuthenticatedPayload(payload);
    else if (provider instanceof GitPushTriggerProvider || provider instanceof IssueEventTriggerProvider) await provider.handle(payload);
    else throw new Error('Trigger provider is not available');
  }, options.queueOptions, () => {
    runtime.recordDiagnostic({ severity: 'error', code: 'trigger.delivery-failed', message: 'A durable trigger delivery failed; inspect queue status' });
  });
  runtimeQueues.set(runtime, { path: resolve(options.queuePath), queue });
  return queue;
}

export function closePluginTriggerQueue(runtime: PluginRuntime): Promise<void> {
  const entry = runtimeQueues.get(runtime);
  if (!entry) return Promise.resolve();
  const release = () => { if (runtimeQueues.get(runtime) === entry) runtimeQueues.delete(runtime); };
  void entry.queue.close({ drain: false }).then(release, release);
  return entry.queue.close({ drain: false, timeoutMs: 5000 });
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part);
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new RangeError('Request exceeds the 1MiB limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function parsePayload(raw: Buffer): unknown {
  const payload: unknown = JSON.parse(raw.toString('utf8'));
  const pending = [{ value: payload, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 10_000 || depth > 32) throw new Error('Trigger payload exceeds structural limits');
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return payload;
}

export async function startPluginListener(runtime: PluginRuntime, options: PluginListenerOptions) {
  if (typeof options.token !== 'string' || options.token.length < 16 || /[\r\n]/.test(options.token)) throw new Error('Listener token must contain at least 16 characters');
  const port = options.port ?? 8374;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listener port');
  const active = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const queue = pluginTriggerQueue(runtime, options);
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('content-type', 'application/json');
    const replay = /^\/deliveries\/([a-f0-9]{64})\/replay$/.exec(request.url ?? '');
    const prune = request.method === 'POST' && request.url === '/deliveries/prune';
    const list = request.method === 'GET' && (request.url ?? '').split('?')[0] === '/deliveries';
    if (list || (request.method === 'POST' && replay) || prune) {
      if (!equalSecret(request.headers.authorization ?? '', `Bearer ${options.token}`)) {
        response.writeHead(401).end('{"error":"Queue authentication failed"}'); return;
      }
      if (!queue) { response.writeHead(503).end('{"error":"Durable trigger queue is not configured"}'); return; }
      try {
        if (prune) {
          await readBody(request);
          const result = JSON.stringify({ removed: queue.pruneDelivered() });
          response.writeHead(200).end(result);
        } else if (replay) {
          await readBody(request);
          const delivery = queue.status(replay[1])[0];
          if (!delivery) { response.writeHead(404).end('{"error":"Unknown trigger delivery"}'); return; }
          if (delivery.status !== 'failed') { response.writeHead(409).end('{"error":"Only failed trigger deliveries can be replayed"}'); return; }
          const receipt = JSON.stringify(queue.replay(replay[1]));
          response.writeHead(202).end(receipt);
        } else {
          const query = new URL(request.url!, 'http://localhost').searchParams;
          const offsetValue = query.get('offset') ?? '0';
          const limitValue = query.get('limit') ?? '100';
          if (!/^\d+$/.test(offsetValue) || !/^\d+$/.test(limitValue) || query.getAll('offset').length > 1 || query.getAll('limit').length > 1) throw new RangeError('Invalid delivery pagination');
          const offset = Number(offsetValue);
          const limit = Number(limitValue);
          const deliveries = queue.status(undefined, { offset, limit });
          const storage = queue.storageUsage();
          const nextOffset = offset + deliveries.length < storage.records ? offset + deliveries.length : null;
          const status = JSON.stringify({ deliveries, storage, offset, limit, nextOffset });
          response.writeHead(200).end(status);
        }
      } catch (error) {
        if (list && error instanceof RangeError) response.writeHead(400).end('{"error":"Invalid delivery pagination"}');
        else response.writeHead(error instanceof RangeError ? 413 : 503).end('{"error":"Trigger queue operation failed"}');
      }
      return;
    }
    const match = /^\/triggers\/([a-z][a-z0-9.-]*)$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !match) { response.writeHead(404).end('{"error":"Unknown trigger endpoint"}'); return; }
    const provider = runtime.getTriggerProvider(match[1]);
    if (!(provider instanceof WebhookTriggerProvider || provider instanceof GitPushTriggerProvider || provider instanceof IssueEventTriggerProvider)) {
      response.writeHead(404).end('{"error":"Trigger provider is not available"}'); return;
    }
    let authenticated = false;
    try {
      const headerAuthenticated = equalSecret(request.headers.authorization ?? '', `Bearer ${options.token}`)
        || (typeof request.headers['x-gitlab-token'] === 'string' && equalSecret(request.headers['x-gitlab-token'], options.token));
      const signature = request.headers['x-hub-signature-256'];
      if (!headerAuthenticated && typeof signature !== 'string') { response.writeHead(401).end('{"error":"Trigger authentication failed"}'); return; }
      const raw = await readBody(request);
      const expected = `sha256=${createHmac('sha256', options.token).update(raw).digest('hex')}`;
      authenticated = headerAuthenticated || (typeof signature === 'string' && equalSecret(signature, expected));
      if (!authenticated) { response.writeHead(401).end('{"error":"Trigger authentication failed"}'); return; }
      if (queue) {
        if (provider instanceof WebhookTriggerProvider && (typeof signature !== 'string' || !provider.verifySignature(raw, signature))) {
          response.writeHead(401).end('{"error":"Trigger authentication failed"}'); return;
        }
        provider.validatePayload(parsePayload(raw));
        const sourceId = request.headers['idempotency-key'] ?? request.headers['x-github-delivery'] ?? request.headers['x-gitlab-event-uuid'];
        if (sourceId !== undefined && typeof sourceId !== 'string') throw new InvalidTriggerDelivery('Invalid delivery id');
        try {
          const receipt = queue.enqueue(match[1], raw.toString('utf8'), sourceId);
          response.writeHead(202).end(JSON.stringify(receipt));
        } catch (error) {
          if (error instanceof TriggerDeliveryConflict || error instanceof InvalidTriggerDelivery) {
            response.writeHead(error instanceof TriggerDeliveryConflict ? 409 : 400).end('{"error":"Invalid or conflicting delivery id"}');
          } else if (error instanceof TriggerQueueFull) {
            runtime.recordDiagnostic({ severity: 'warning', code: 'trigger.queue-full', message: 'Trigger queue capacity reached; inspect retained deliveries' });
            response.writeHead(503).end('{"error":"Trigger queue is full"}');
          } else {
            runtime.recordDiagnostic({ severity: 'error', code: 'trigger.persistence-failed', message: 'Trigger receipt could not be persisted' });
            response.writeHead(503).end('{"error":"Trigger receipt could not be persisted"}');
          }
        }
        return;
      }
      let receipt: { readonly dispatched: number };
      if (provider instanceof WebhookTriggerProvider) receipt = await provider.handle(raw, typeof signature === 'string' ? signature : '');
      else {
        const payload: unknown = JSON.parse(raw.toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected an event object');
        if (provider instanceof GitPushTriggerProvider) {
          if (!('ref' in payload) || typeof payload.ref !== 'string') throw new Error('Expected a Git push ref');
          receipt = await provider.handlePush(payload as Parameters<GitPushTriggerProvider['handlePush']>[0]);
        } else {
          if (!('action' in payload) || typeof payload.action !== 'string') throw new Error('Expected an issue action');
          receipt = await provider.handleIssue(payload as Parameters<IssueEventTriggerProvider['handleIssue']>[0]);
        }
      }
      response.writeHead(200).end(JSON.stringify(receipt));
    } catch (error) {
      if (authenticated) runtime.recordDiagnostic({ severity: 'error', code: 'trigger.dispatch-failed', message: 'An authenticated trigger request could not be dispatched' });
      response.writeHead(error instanceof RangeError ? 413 : 400).end('{"error":"Trigger dispatch failed"}');
    }
  };
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (request, response) => {
    if (closing) { response.writeHead(503).end(); return; }
    const work = handle(request, response).catch(() => {
      runtime.recordDiagnostic({ severity: 'error', code: 'trigger.request-failed', message: 'Trigger request failed' });
      response.destroy();
    });
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(port, options.host ?? '127.0.0.1', () => { server.off('error', onError); resolve(); });
    });
    queue?.start();
  } catch (error) { await closePluginTriggerQueue(runtime); throw error; }
  return {
    address: server.address(),
    queue,
    close(): Promise<void> {
      return closing ??= new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Trigger listener shutdown timed out; unconfirmed delivery ownership is retained')), 5000);
        const stopped = new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
        Promise.all([stopped, Promise.allSettled([...active]), closePluginTriggerQueue(runtime)])
          .then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
    },
  };
}
