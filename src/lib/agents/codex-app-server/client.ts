import type { AppServerTransport, JsonRpcId, JsonRpcMessage } from './transport';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationQueue: JsonRpcMessage[] = [];
  private readonly notificationReaders: Array<(result: IteratorResult<JsonRpcMessage>) => void> = [];
  private started = false;
  private closed = false;
  private notificationsEnded = false;

  constructor(readonly transport: AppServerTransport) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.consume();
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new Error('Codex app-server client is closed');
    this.start();
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
    });
    try {
      await this.transport.send({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error('Codex app-server client is closed');
    this.start();
    await this.transport.send({ jsonrpc: '2.0', method, params });
  }

  notifications(): AsyncIterable<JsonRpcMessage> {
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.nextNotification() }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close();
    this.failPending(new Error('Codex app-server transport closed'));
    this.endNotifications();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.transport.messages()) {
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`Codex app-server error ${message.error.code}: ${message.error.message}`));
          else pending.resolve(message.result);
          continue;
        }
        if (message.method) this.pushNotification(message);
      }
      this.failPending(new Error('Codex app-server transport closed'));
    } catch (error) {
      this.failPending(transportFailure(error));
    } finally {
      this.endNotifications();
    }
  }

  private pushNotification(message: JsonRpcMessage): void {
    const reader = this.notificationReaders.shift();
    if (reader) reader({ done: false, value: message });
    else this.notificationQueue.push(message);
  }

  private nextNotification(): Promise<IteratorResult<JsonRpcMessage>> {
    const message = this.notificationQueue.shift();
    if (message) return Promise.resolve({ done: false, value: message });
    if (this.closed || this.notificationsEnded) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.notificationReaders.push(resolve));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private endNotifications(): void {
    this.notificationsEnded = true;
    for (const reader of this.notificationReaders.splice(0)) reader({ done: true, value: undefined });
  }
}

function transportFailure(error: unknown): Error {
  const failure = new Error('Codex app-server transport closed unexpectedly') as NodeJS.ErrnoException;
  if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
    failure.code = 'ENOENT';
  }
  return failure;
}
