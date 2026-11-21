import { describe, expect, it, vi } from 'vitest';
import { resolveOperationSecret, resolveWebhook } from './operation-secret.js';

describe('ordinary shared operation secret contract', () => {
  it('preserves static strings and reads a fresh value on each operation', async () => {
    await expect(resolveOperationSecret('static')).resolves.toBe('static');
    const resolve = vi.fn().mockResolvedValueOnce({ secret: 'one' }).mockResolvedValueOnce({ secret: 'two', revoked: false });
    expect(await resolveOperationSecret(resolve)).toBe('one');
    expect(await resolveOperationSecret(resolve)).toBe('two'); expect(resolve).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, [], {}, { secret: '' }, { secret: 'x', expiresAt: 42 }, { secret: 'x', revoked: true }])('rejects invalid ordinary result %j', async value => {
    await expect(resolveOperationSecret(async () => value as never)).rejects.toThrow(/^Operation credential unavailable$/);
  });

  it('cleans up structural abort listeners and consumes a late rejection', async () => {
    const listeners = new Set<() => void>();
    const signal = { aborted: false, reason: 'private reason',
      addEventListener: (_event: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_event: string, listener: () => void) => { listeners.delete(listener); } };
    let fail!: (error: Error) => void;
    const resolve = vi.fn(() => new Promise<never>((_done, reject) => { fail = reject; }));
    const pending = resolveOperationSecret(resolve, { signal }); await Promise.resolve();
    signal.aborted = true; for (const listener of listeners) listener();
    await expect(pending).rejects.toThrow(/^Operation credential unavailable$/); expect(listeners.size).toBe(0);
    fail(new Error('unreturned private secret')); await Promise.resolve();
  });

  it.each([NaN, Infinity, -1, 0])('does not invoke a resolver for invalid/past deadline %s', async deadlineAt => {
    const resolve = vi.fn(async () => ({ secret: 'unused' }));
    await expect(resolveOperationSecret(resolve, { deadlineAt })).rejects.toThrow(/^Operation credential unavailable$/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('validates static and newly resolved webhook values with safe errors', async () => {
    expect(await resolveWebhook('https://hooks.example.test/static')).toBe('https://hooks.example.test/static');
    await expect(resolveWebhook(async () => ({ secret: 'file:///private' }))).rejects.toThrow(/^Invalid webhook configuration$/);
  });
});
