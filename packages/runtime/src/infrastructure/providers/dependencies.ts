import { spawn } from 'node:child_process';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';

export type FetchTransport = typeof globalThis.fetch;

export interface CommandRequest extends ProviderOperationOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly input?: string;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandExecutor = (request: CommandRequest) => Promise<CommandResult>;

export function checkAbort(options?: ProviderOperationOptions): void {
  if (options?.signal?.aborted) throw options.signal.reason;
}

export interface HttpRequestOptions extends ProviderOperationOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export async function requestHttp(
  transport: FetchTransport | undefined,
  url: string | URL,
  init: RequestInit,
  options?: HttpRequestOptions,
): Promise<Response> {
  checkAbort(options);
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const maxResponseBytes = options?.maxResponseBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error('Invalid HTTP timeout');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new Error('Invalid HTTP response limit');
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new Error('Expected an absolute HTTP endpoint'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Expected an HTTP endpoint without embedded credentials');
  }
  const controller = new AbortController();
  const sources = [options?.signal, init.signal].filter(signal => signal !== undefined && signal !== null);
  const listeners = sources.map(signal => {
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return { signal, abort };
  });
  let onAbort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error('Provider HTTP request timed out')), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let received: Response | undefined;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await Promise.race([
      (transport ?? globalThis.fetch)(endpoint, { ...init, redirect: 'error', signal: controller.signal }).then(response => {
        received = response;
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw controller.signal.reason;
        }
        return response;
      }),
      interrupted,
    ]);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Provider HTTP request failed (${response.status})`);
    }
    if (!response.body) return response;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxResponseBytes) throw new Error('Provider HTTP response exceeded limit');
      chunks.push(chunk.value);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    return new Response(Buffer.concat(chunks, length), { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof Error && /^Provider HTTP (request failed \(\d+\)|response exceeded limit)$/.test(error.message)) throw error;
    throw new Error('Provider HTTP transport failed');
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    for (const { signal, abort } of listeners) signal.removeEventListener('abort', abort);
    if (reader) void reader.cancel().catch(() => undefined);
    else if (received) void received.body?.cancel().catch(() => undefined);
  }
}

export const executeCommand: CommandExecutor = async request => {
  checkAbort(request);
  if (!request.command || request.command.includes('\0') || request.args.some(argument => argument.includes('\0'))) {
    throw new Error('Invalid process arguments');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], { cwd: request.cwd, shell: false, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new Error('Provider command aborted'));
    const timer = setTimeout(() => stop(new Error('Provider command timed out')), 30_000);
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop(new Error('Provider command output exceeded limit'));
      else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
    };
    child.on('error', () => {
      cleanup();
      reject(new Error('Provider command could not start'));
    });
    child.on('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Provider command failed (${code ?? 'signal'})`));
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.input);
  });
};
