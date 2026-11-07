import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebhookTriggerProvider, GitPushTriggerProvider, IssueEventTriggerProvider } from '../../infrastructure/providers/triggers.js';
import type { PluginRuntime } from './runtime.js';

export interface PluginListenerOptions {
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
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
    if (bytes > 1024 * 1024) throw new Error('Request exceeds the 1MiB limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export async function startPluginListener(runtime: PluginRuntime, options: PluginListenerOptions) {
  if (typeof options.token !== 'string' || options.token.length < 16 || /[\r\n]/.test(options.token)) throw new Error('Listener token must contain at least 16 characters');
  const port = options.port ?? 8374;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listener port');
  const active = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('content-type', 'application/json');
    const match = /^\/triggers\/([a-z][a-z0-9.-]*)$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !match) { response.writeHead(404).end('{"error":"Unknown trigger endpoint"}'); return; }
    const provider = runtime.getTriggerProvider(match[1]);
    if (!(provider instanceof WebhookTriggerProvider || provider instanceof GitPushTriggerProvider || provider instanceof IssueEventTriggerProvider)) {
      response.writeHead(404).end('{"error":"Trigger provider is not available"}'); return;
    }
    try {
      const raw = await readBody(request);
      const signature = request.headers['x-hub-signature-256'];
      const expected = `sha256=${createHmac('sha256', options.token).update(raw).digest('hex')}`;
      const authenticated = equalSecret(request.headers.authorization ?? '', `Bearer ${options.token}`)
        || (typeof request.headers['x-gitlab-token'] === 'string' && equalSecret(request.headers['x-gitlab-token'], options.token))
        || (typeof signature === 'string' && equalSecret(signature, expected));
      if (!authenticated) { response.writeHead(401).end('{"error":"Trigger authentication failed"}'); return; }
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
    } catch {
      runtime.recordDiagnostic({ severity: 'error', code: 'trigger.dispatch-failed', message: 'An authenticated trigger request could not be dispatched' });
      response.writeHead(400).end('{"error":"Trigger dispatch failed"}');
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
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, options.host ?? '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
  return {
    address: server.address(),
    close(): Promise<void> {
      return closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
        try { await stopped; } finally { await Promise.allSettled([...active]); }
      })();
    },
  };
}
