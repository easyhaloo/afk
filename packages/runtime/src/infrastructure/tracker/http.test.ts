import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { normalizeBaseUrl, requestJson, type FetchLike } from './http.js';
import { IssueTrackerError } from './issue-tracker-error.js';

const schema = z.object({ id: z.string() });
function request(fetcher: FetchLike, extra: Partial<Parameters<typeof requestJson>[0]> = {}) {
  return requestJson({ provider: 'test', operation: 'read', url: new URL('https://example.test'), fetch: fetcher, init: {}, schema, ...extra });
}

afterEach(() => { vi.useRealTimers(); });

describe('tracker HTTP boundary', () => {
  it.each(['not a URL', 'file:///tmp/test', 'https://user:secret@example.test', 'https://example.test?token=secret', 'https://example.test#secret'])('rejects unsafe base URL %s without echoing credentials', value => {
    try { normalizeBaseUrl('test', 'init', value); throw new Error('expected rejection'); } catch (error) {
      expect(error).toMatchObject({ code: 'configuration' });
      expect(String(error)).not.toContain('secret');
    }
  });

  it.each([[401, 'authentication'], [403, 'forbidden'], [404, 'not-found'], [429, 'rate-limited'], [500, 'request-failed']] as const)('classifies HTTP %i without reading its secret-bearing body', async (status, code) => {
    const response = new Response('secret-token', { status, headers: { 'retry-after': '2' } });
    const read = vi.spyOn(response, 'text');
    const error = await request(async () => response).catch(value => value);
    expect(error).toMatchObject({ code, details: { status, retryAfterMs: 2000 } });
    expect(read).not.toHaveBeenCalled();
    expect(inspect(error, { depth: 10 })).not.toContain('secret-token');
  });

  it.each([
    { errors: [{ message: 'secret-token' }] }, { errorMessages: ['secret-token'] },
    { errors: { authorization: 'secret-token' } }, { error: 'secret-token' },
    { success: false }, { wrongField: 'secret-token' }, null,
  ])('rejects error payloads and schema mismatches even on HTTP 200', async body => {
    const error = await request(async () => new Response(JSON.stringify(body))).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error, { depth: 10 })).not.toContain('secret-token');
  });

  it('strips raw transport exceptions and nested causes', async () => {
    const error = await request(async () => { throw new Error('secret-token', { cause: { headers: { Authorization: 'secret-token' } } }); }).catch(value => value);
    expect(error).toMatchObject({ code: 'request-failed' });
    expect(error).not.toHaveProperty('cause');
    expect(inspect(error, { depth: 10 })).not.toContain('secret-token');
  });

  it('sanitizes body read errors', async () => {
    const response = new Response('{}');
    vi.spyOn(response, 'text').mockRejectedValue(new Error('secret-token'));
    const error = await request(async () => response).catch(value => value);
    expect(error).toMatchObject({ code: 'request-failed' });
    expect(inspect(error, { depth: 10 })).not.toContain('secret-token');
  });

  it('does not trust an injected transport error even if it has the same error class', async () => {
    const error = await request(async () => { throw new IssueTrackerError('request-failed', 'secret-token', { provider: 'secret-token', operation: 'unsafe' }); }).catch(value => value);
    expect(error).toMatchObject({ code: 'request-failed', details: { provider: 'test', operation: 'read' } });
    expect(inspect(error, { depth: 10 })).not.toContain('secret-token');
  });

  it.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])('rejects invalid timeout values (%s) before calling fetch', async timeoutMs => {
    const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    await expect(request(fetcher, { timeoutMs })).rejects.toMatchObject({ code: 'configuration' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('times out and aborts fetch even if the injected transport ignores the signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const pending = request(async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); }, { timeoutMs: 20 }).catch(value => value);
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toMatchObject({ code: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the timeout to stalled response bodies too', async () => {
    vi.useFakeTimers();
    const response = new Response('{}');
    vi.spyOn(response, 'text').mockReturnValue(new Promise<string>(() => {}));
    const pending = request(async () => response, { timeoutMs: 15 }).catch(value => value);
    await vi.advanceTimersByTimeAsync(15);
    await expect(pending).resolves.toMatchObject({ code: 'timeout' });
  });

  it('rejects invalid JSON and unexpected empty success responses', async () => {
    await expect(request(async () => new Response('not-json'))).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(request(async () => new Response(null, { status: 204 }))).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('permits expected empty responses and blocks redirects carrying credentials', async () => {
    const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(request(fetcher, { schema: undefined, allowEmpty: true, statuses: [204] })).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('clears timeout timers after a successful request', async () => {
    vi.useFakeTimers();
    await expect(request(async () => new Response('{"id":"native"}'))).resolves.toEqual({ id: 'native' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
