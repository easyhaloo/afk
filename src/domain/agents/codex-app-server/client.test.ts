import { describe, expect, it } from 'vitest';
import { AppServerClient } from './client';
import type { AppServerTransport, JsonRpcMessage } from './transport';

class MemoryTransport implements AppServerTransport {
  readonly endpointKind = 'stdio' as const;
  readonly sent: JsonRpcMessage[] = [];
  private readonly queue: JsonRpcMessage[] = [];
  private readonly readers: Array<(value: IteratorResult<JsonRpcMessage>) => void> = [];
  private ended = false;

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
  }

  push(message: JsonRpcMessage): void {
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value: message });
    else this.queue.push(message);
  }

  messages(): AsyncIterable<JsonRpcMessage> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
  }

  async close(): Promise<void> {
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
  }

  private next(): Promise<IteratorResult<JsonRpcMessage>> {
    const message = this.queue.shift();
    if (message) return Promise.resolve({ done: false, value: message });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.readers.push(resolve));
  }
}

describe('AppServerClient', () => {
  it('correlates out-of-order responses by request ID', async () => {
    const transport = new MemoryTransport();
    const client = new AppServerClient(transport);
    client.start();

    const first = client.request<{ value: string }>('first', { n: 1 });
    const second = client.request<{ value: string }>('second', { n: 2 });
    await Promise.resolve();
    const firstId = transport.sent[0]!.id;
    const secondId = transport.sent[1]!.id;
    transport.push({ jsonrpc: '2.0', id: secondId, result: { value: 'two' } });
    transport.push({ jsonrpc: '2.0', id: firstId, result: { value: 'one' } });

    await expect(first).resolves.toEqual({ value: 'one' });
    await expect(second).resolves.toEqual({ value: 'two' });
    await client.close();
  });

  it('rejects only the matching request on a server error', async () => {
    const transport = new MemoryTransport();
    const client = new AppServerClient(transport);
    client.start();
    const request = client.request('turn/start', {});
    await Promise.resolve();
    transport.push({
      jsonrpc: '2.0', id: transport.sent[0]!.id,
      error: { code: -32602, message: 'invalid params' },
    });

    await expect(request).rejects.toThrow(/invalid params/);
    await client.close();
  });

  it('rejects pending requests when the transport closes', async () => {
    const transport = new MemoryTransport();
    const client = new AppServerClient(transport);
    client.start();
    const request = client.request('thread/start', {});
    await Promise.resolve();
    await transport.close();

    await expect(request).rejects.toThrow(/closed/i);
  });
});
