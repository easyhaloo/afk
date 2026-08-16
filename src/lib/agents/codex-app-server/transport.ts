import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import WebSocket from 'ws';
import type { CodexRuntimeSelection } from '../types';

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AppServerTransport {
  readonly endpointKind: 'stdio' | 'unix' | 'ws' | 'wss';
  send(message: JsonRpcMessage): Promise<void>;
  messages(): AsyncIterable<JsonRpcMessage>;
  close(): Promise<void>;
}

export async function createAppServerTransport(runtime: CodexRuntimeSelection): Promise<AppServerTransport> {
  const endpoint = runtime.endpoint ?? 'stdio://';
  if (endpoint === 'stdio://') return StdioAppServerTransport.start(runtime);
  if (endpoint.startsWith('unix://')) {
    return WebSocketAppServerTransport.connectUnix(endpoint.slice('unix://'.length));
  }
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
    const token = runtime.authTokenEnv ? process.env[runtime.authTokenEnv] : undefined;
    if (runtime.authTokenEnv && !token) {
      throw new Error('Configured Codex app-server authentication environment variable is not set');
    }
    return WebSocketAppServerTransport.connect(endpoint, token);
  }
  throw new Error('Unsupported Codex app-server endpoint');
}

class MessageQueue<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader) reader.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const reader of this.readers.splice(0)) {
      if (error) reader.reject(error);
      else reader.resolve({ done: true, value: undefined });
    }
  }

  iterable(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.next(),
      }),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
  }
}

class StdioAppServerTransport implements AppServerTransport {
  readonly endpointKind = 'stdio' as const;
  private readonly queue = new MessageQueue<JsonRpcMessage>();
  private stdoutBuffer = '';
  private closed = false;

  private constructor(private readonly process: ChildProcess) {
    process.stdout?.on('data', chunk => {
      this.stdoutBuffer += String(chunk);
      this.drainLines();
    });
    process.stderr?.resume();
    process.on('error', error => this.queue.end(error));
    process.on('exit', code => {
      if (this.stdoutBuffer.trim()) this.parseLine(this.stdoutBuffer);
      this.stdoutBuffer = '';
      this.queue.end(code && code !== 0 ? new Error(`Codex app-server exited with code ${code}`) : undefined);
    });
  }

  static start(runtime: CodexRuntimeSelection): StdioAppServerTransport {
    const args = ['app-server', '--listen', 'stdio://'];
    if (runtime.profile) args.unshift('--profile', runtime.profile);
    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    return new StdioAppServerTransport(child);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed || !this.process.stdin) throw new Error('Codex app-server transport is closed');
    await new Promise<void>((resolve, reject) => {
      this.process.stdin!.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
    });
  }

  messages(): AsyncIterable<JsonRpcMessage> {
    return this.queue.iterable();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.stdin?.end();
    if (this.process.exitCode === null && this.process.pid) this.process.kill('SIGTERM');
    this.queue.end();
  }

  private drainLines(): void {
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    try {
      const value = JSON.parse(line) as JsonRpcMessage;
      if (value?.jsonrpc === '2.0') this.queue.push(value);
    } catch {
      // Stderr/stdout diagnostics are intentionally not surfaced as credentials may be present.
    }
  }
}

class WebSocketAppServerTransport implements AppServerTransport {
  private readonly queue = new MessageQueue<JsonRpcMessage>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly endpointKind: 'unix' | 'ws' | 'wss',
  ) {
    socket.on('message', data => {
      try {
        const value = JSON.parse(data.toString()) as JsonRpcMessage;
        if (value?.jsonrpc === '2.0') this.queue.push(value);
      } catch {
        // Ignore malformed remote diagnostics; the protocol client remains alive.
      }
    });
    socket.on('error', error => this.queue.end(error));
    socket.on('close', () => this.queue.end());
  }

  static async connect(endpoint: string, token?: string): Promise<WebSocketAppServerTransport> {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const socket = new WebSocket(endpoint, { headers });
    await waitForOpen(socket);
    return new WebSocketAppServerTransport(socket, endpoint.startsWith('wss://') ? 'wss' : 'ws');
  }

  static async connectUnix(socketPath: string): Promise<WebSocketAppServerTransport> {
    if (!socketPath) throw new Error('Codex app-server Unix socket path is required');
    const socket = new WebSocket('ws://localhost/', {
      createConnection: () => createConnection(socketPath),
    });
    await waitForOpen(socket);
    return new WebSocketAppServerTransport(socket, 'unix');
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex app-server transport is closed');
    await new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(message), error => error ? reject(error) : resolve());
    });
  }

  messages(): AsyncIterable<JsonRpcMessage> {
    return this.queue.iterable();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.queue.end();
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}
