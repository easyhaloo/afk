import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import WebSocket from 'ws';

type AppServerMessage = { [key: string]: unknown };
import type { CodexRuntimeSelection } from '../types';

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
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
  if (runtime.profile) throw new Error('Codex profile is not supported with app-server transport');
  if (endpoint === 'stdio://') {
    const args = ['app-server', '--listen', 'stdio://'];
    return createStdioAppServerTransport('codex', args);
  }
  if (endpoint.startsWith('unix://')) {
    return WebSocketAppServerTransport.connectUnix(
      endpoint.slice('unix://'.length),
      runtime.startupTimeoutMs,
    );
  }
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
    const token = runtime.authTokenEnv ? process.env[runtime.authTokenEnv] : undefined;
    if (runtime.authTokenEnv && !token) {
      throw new Error('Configured Codex app-server authentication environment variable is not set');
    }
    return WebSocketAppServerTransport.connect(endpoint, token, runtime.startupTimeoutMs);
  }
  throw new Error('Unsupported Codex app-server endpoint');
}

export function createStdioAppServerTransport(
  executable: string,
  args: readonly string[],
): Promise<AppServerTransport> {
  return StdioAppServerTransport.start(executable, args);
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
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private closePromise?: Promise<void>;

  private constructor(private readonly process: ChildProcess) {
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    process.stdout?.on('data', chunk => {
      this.stdoutBuffer += String(chunk);
      this.drainLines();
    });
    process.stderr?.resume();
    process.on('error', error => {
      this.queue.end(error);
      this.resolveExited();
    });
    process.on('exit', code => {
      if (this.stdoutBuffer.trim()) this.parseLine(this.stdoutBuffer);
      this.stdoutBuffer = '';
      this.queue.end(code && code !== 0 ? new Error(`Codex app-server exited with code ${code}`) : undefined);
      this.resolveExited();
    });
  }

  static start(executable: string, args: readonly string[]): Promise<StdioAppServerTransport> {
    const child = spawn(executable, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);
        resolve(new StdioAppServerTransport(child));
      });
    });
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
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.process.stdin?.end();
    this.queue.end();
    this.closePromise = this.terminate();
    return this.closePromise;
  }

  private async terminate(): Promise<void> {
    if (hasExited(this.process)) return;
    this.process.kill('SIGTERM');
    if (await settlesWithin(this.exited, 250)) return;
    this.process.kill('SIGKILL');
    if (!await settlesWithin(this.exited, 1_000)) {
      throw new Error('Codex app-server process did not exit after SIGKILL');
    }
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
      const value = JSON.parse(line) as unknown;
      if (isAppServerMessage(value)) this.queue.push(value);
    } catch {
      // Stderr/stdout diagnostics are intentionally not surfaced as credentials may be present.
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([promise.then(() => true as const), timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

class WebSocketAppServerTransport implements AppServerTransport {
  private readonly queue = new MessageQueue<JsonRpcMessage>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly endpointKind: 'unix' | 'ws' | 'wss',
    private readonly closeTimeoutMs: number,
  ) {
    socket.on('message', data => {
      try {
        const value = JSON.parse(data.toString()) as unknown;
        if (isAppServerMessage(value)) this.queue.push(value);
      } catch {
        // Ignore malformed remote diagnostics; the protocol client remains alive.
      }
    });
    socket.on('error', error => this.queue.end(error));
    socket.on('close', () => this.queue.end());
  }

  static async connect(
    endpoint: string,
    token: string | undefined,
    startupTimeoutMs: number,
  ): Promise<WebSocketAppServerTransport> {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const socket = new WebSocket(endpoint, { headers });
    await waitForWebSocketOpen(socket, startupTimeoutMs);
    return new WebSocketAppServerTransport(
      socket,
      endpoint.startsWith('wss://') ? 'wss' : 'ws',
      Math.min(startupTimeoutMs, 1_000),
    );
  }

  static async connectUnix(
    socketPath: string,
    startupTimeoutMs: number,
  ): Promise<WebSocketAppServerTransport> {
    if (!socketPath) throw new Error('Codex app-server Unix socket path is required');
    const socket = new WebSocket('ws://localhost/', {
      createConnection: () => createConnection(socketPath),
    });
    await waitForWebSocketOpen(socket, startupTimeoutMs);
    return new WebSocketAppServerTransport(socket, 'unix', Math.min(startupTimeoutMs, 1_000));
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
    try {
      await closeWebSocket(this.socket, this.closeTimeoutMs);
    } finally {
      this.queue.end();
    }
  }
}

function isAppServerMessage(value: unknown): value is JsonRpcMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as AppServerMessage;
  if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') return false;
  if (typeof message.method === 'string') return true;
  return 'id' in message && ('result' in message || 'error' in message);
}

export function waitForWebSocketOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      const ignoreTerminationError = () => {};
      const removeTerminationError = () => socket.off('error', ignoreTerminationError);
      socket.once('error', ignoreTerminationError);
      socket.once('close', removeTerminationError);
      socket.terminate();
      reject(new Error('Codex app-server connection timed out'));
    }, timeoutMs);
  });
}

export async function closeWebSocket(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else socket.close();
  if (await waitForSocketClose(socket, timeoutMs)) return;
  socket.terminate();
  if (!await waitForSocketClose(socket, timeoutMs)) {
    throw new Error('Codex app-server WebSocket did not close after termination');
  }
}

function waitForSocketClose(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(true);
  return new Promise(resolve => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    socket.once('close', onClose);
  });
}
