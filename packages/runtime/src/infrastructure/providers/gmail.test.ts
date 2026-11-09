import { describe, expect, it, vi } from 'vitest';
import { GmailNotificationProvider } from './gmail.js';
import { GoogleOAuthError } from './google-oauth.js';

const message = { title: '验证成功 ✅', body: '中文正文\nSecond line' };
function credentials() {
  return {
    resolveAccount: vi.fn(async () => ({ secret: 'SYNTHETIC_ACCESS', subject: 'user-123', email: 'selected@example.test' })),
  };
}

describe('Gmail notification', () => {
  it.each([undefined, 'recipient@example.test'])('sends a UTF-8 MIME message through Gmail API, recipient=%s', async to => {
    const account = credentials();
    const transport = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"id":"message-123"}'));
    const provider = new GmailNotificationProvider({ credentials: account, to, fetch: transport });
    expect(await provider.notify(message)).toEqual({ delivered: true, channel: 'gmail' });
    expect(String(transport.mock.calls[0][0])).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const request = transport.mock.calls[0][1]!;
    expect(request.headers).toEqual({ authorization: 'Bearer SYNTHETIC_ACCESS', 'content-type': 'application/json' });
    const mime = Buffer.from(JSON.parse(String(request.body)).raw, 'base64url').toString();
    expect(mime).toContain('From: selected@example.test\r\n');
    expect(mime).toContain(`To: ${to ?? 'selected@example.test'}\r\n`);
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from(message.title).toString('base64')}?=`);
    expect(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString()).toBe(message.body);
  });

  it('folds long Unicode subjects without splitting characters or overflowing encoded words', async () => {
    const transport = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"id":"accepted"}'));
    const title = '复杂标题🙂'.repeat(30);
    await new GmailNotificationProvider({ credentials: credentials(), fetch: transport }).notify({ title, body: '' });
    const mime = Buffer.from(JSON.parse(String(transport.mock.calls[0][1]?.body)).raw, 'base64url').toString();
    const encoded = [...mime.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    expect(encoded.map(match => Buffer.from(match[1], 'base64').toString()).join('')).toBe(title);
    expect(encoded.every(match => match[0].length <= 75)).toBe(true);
  });

  it('rejects header injection before reading credentials or contacting Google', async () => {
    const account = credentials();
    const transport = vi.fn();
    const provider = new GmailNotificationProvider({ credentials: account, fetch: transport });
    expect((await provider.notify({ ...message, title: 'Hello\r\nBcc: attacker@example.test' })).delivered).toBe(false);
    expect(account.resolveAccount).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(() => new GmailNotificationProvider({ to: 'me@example.test\nBcc: other@example.test' })).toThrow('Invalid');
  });

  it('reports failure without exposing tokens or Google response bodies', async () => {
    const provider = new GmailNotificationProvider({ credentials: credentials(), fetch: async () => new Response('SYNTHETIC_ACCESS', { status: 403 }) });
    const receipt = await provider.notify(message);
    expect(receipt.delivered).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC_ACCESS');
    const noReceipt = new GmailNotificationProvider({ credentials: credentials(), fetch: async () => new Response('{}') });
    expect((await noReceipt.notify(message)).delivered).toBe(false);
  });

  it.each([
    [401, 'Google sign-in expired or was revoked; sign in again'],
    [403, 'Gmail API access was denied; check Gmail API enablement and the granted sending permission'],
    [429, 'Gmail rate limit reached; retry later'],
  ])('reports a safe action for HTTP %s without response details', async (status, error) => {
    const provider = new GmailNotificationProvider({ credentials: credentials(), fetch: async () => new Response('SYNTHETIC_PRIVATE_RESPONSE', { status }) });
    expect(await provider.notify(message)).toEqual({ delivered: false, channel: 'gmail', error });
  });

  it('identifies transport failures and safe OAuth failures without leaking native errors', async () => {
    const transport = new GmailNotificationProvider({ credentials: credentials(), fetch: async () => { throw new Error('SYNTHETIC_PRIVATE_TRANSPORT'); } });
    expect((await transport.notify(message)).error).toBe('Cannot reach Gmail; check the network and HTTP or HTTPS proxy settings');
    const account = credentials();
    account.resolveAccount.mockRejectedValue(new GoogleOAuthError('token.scope', ['https://www.googleapis.com/auth/gmail.send']));
    const provider = new GmailNotificationProvider({ credentials: account, fetch: vi.fn() });
    const result = await provider.notify(message);
    expect(result.error).toContain('token.scope');
    expect(result.error).toContain('Missing: Send email on your behalf');
  });
});
