import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCommand, requestHttp } from './dependencies.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('provider dependencies', () => {
  it('defaults to global fetch on invocation and rejects invalid endpoints before transport', async () => {
    const globalFetch = vi.fn(async () => new Response('global transport'));
    vi.stubGlobal('fetch', globalFetch);
    expect(await (await requestHttp(undefined, 'https://example.test', {})).text()).toBe('global transport');
    expect(globalFetch).toHaveBeenCalledOnce();
    const fetch = vi.fn();
    for (const url of ['file:///tmp/secret', 'https://user:secret@example.test']) {
      await expect(requestHttp(fetch, url, {})).rejects.toThrow('HTTP endpoint');
    }
    await expect(requestHttp(fetch, 'invalid-secret-endpoint', {})).rejects.toThrow('Expected an absolute HTTP endpoint');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bridges structural signals, blocks redirects and sanitizes transport errors', async () => {
    const listeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    };
    const fetch = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new Error('secret-webhook-token');
    });
    await expect(requestHttp(fetch, 'https://example.test', {}, { signal })).rejects.toThrow('transport failed');
    expect(listeners.size).toBe(0);
  });

  it('uses real global fetch against a loopback server', async () => {
    const server = createServer((_request, response) => { response.end('real HTTP body'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const response = await requestHttp(undefined, `http://127.0.0.1:${address.port}/`, {});
      expect(await response.text()).toBe('real HTTP body');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('times out even if an injected transport ignores abort', async () => {
    await expect(requestHttp(async () => new Promise<Response>(() => undefined), 'https://example.test', {}, { timeoutMs: 10 })).rejects.toThrow('timed out');
  });

  it('keeps timeout and cancellation active while consuming the response body', async () => {
    const cancelled = vi.fn();
    const transport = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    await expect(requestHttp(transport, 'https://example.test', {}, { timeoutMs: 10 })).rejects.toThrow('timed out');
    expect(cancelled).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const bodyCancelled = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      pull() { controller.abort(new Error('cancelled during body')); }, cancel: bodyCancelled,
    })));
    await expect(requestHttp(fetch, 'https://example.test', {}, { signal: controller.signal })).rejects.toThrow('cancelled during body');
    expect(bodyCancelled).toHaveBeenCalledOnce();
  });

  it('respects RequestInit signals and removes structural signal listeners', async () => {
    const controller = new AbortController();
    const pending = requestHttp(async () => new Promise<Response>(() => undefined), 'https://example.test', { signal: controller.signal });
    controller.abort(new Error('init aborted'));
    await expect(pending).rejects.toThrow('init aborted');
    const listeners = new Set<() => void>();
    const signal = { aborted: false, addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); }, removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); } };
    await requestHttp(async () => new Response('ok'), 'https://example.test', {}, { signal });
    expect(listeners.size).toBe(0);
  });

  it('limits streamed bytes and closes the stream on failure', async () => {
    const cancelled = vi.fn();
    const fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8)); }, cancel: cancelled,
    }));
    await expect(requestHttp(fetch, 'https://example.test', {}, { maxResponseBytes: 4 })).rejects.toThrow('exceeded limit');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('validates resource limits and supports empty response bodies', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    for (const timeoutMs of [0, -1, NaN, Infinity, 300001]) {
      await expect(requestHttp(fetch, 'https://example.test', {}, { timeoutMs })).rejects.toThrow('Invalid HTTP timeout');
    }
    await expect(requestHttp(fetch, 'https://example.test', {}, { maxResponseBytes: 0 })).rejects.toThrow('Invalid HTTP response limit');
    expect(fetch).not.toHaveBeenCalled();
    expect((await requestHttp(fetch, 'https://example.test', {})).status).toBe(204);
  });

  it('rejects aborted operations before IO and reports only HTTP status', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fetch = vi.fn();
    await expect(requestHttp(fetch, 'https://example.test', {}, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
    await expect(requestHttp(async () => new Response('secret', { status: 403 }), 'https://example.test', {}))
      .rejects.toThrow('Provider HTTP request failed (403)');
  });

  it('executes argv without a shell and sends sensitive data on stdin', async () => {
    const input = '$(touch /tmp/never-run)';
    const result = await executeCommand({
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      input,
    });
    expect(result).toEqual({ stdout: input, stderr: '' });
  });

  it('rejects failure, invalid arguments, output overflow and cancellation', async () => {
    await expect(executeCommand({ command: process.execPath, args: ['-e', 'process.stderr.write("secret");process.exit(7)'] }))
      .rejects.toThrow('Provider command failed (7)');
    await expect(executeCommand({ command: 'bad\0command', args: [] })).rejects.toThrow('Invalid process');
    await expect(executeCommand({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(5*1024*1024))'] }))
      .rejects.toThrow('output exceeded limit');
    const controller = new AbortController();
    const pending = executeCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});
