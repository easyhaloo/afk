import { describe, expect, it, vi } from 'vitest';
import { GmailNotificationProvider } from './gmail.js';
import { GMAIL_SEND_SCOPE, GoogleOAuthCredentialProvider, GoogleOAuthError } from './google-oauth.js';
import { createBuiltinCapabilityPlugins } from '../../application/plugins/builtin-capabilities.js';

const message = { title: '验证成功 ✅', body: '中文正文\nSecond line' };
function credentials() {
  return {
    resolveAccount: vi.fn(async () => ({ secret: 'SYNTHETIC_ACCESS', subject: 'user-123', email: 'selected@example.test' })),
  };
}

describe('Gmail passive diagnostics', () => {
  it('sanitizes a throwing health accessor through provider and builtin diagnostics', async () => {
    const account = Object.defineProperty(credentials(), 'health', {
      get: () => { throw new Error('SYNTHETIC_PRIVATE_ACCESSOR selected@example.test'); },
    });
    const transport = vi.fn();
    const provider = new GmailNotificationProvider({ credentials: account, fetch: transport });
    const plugin = createBuiltinCapabilityPlugins({ notifications: [provider] })[0];
    const reports = {
      health: await provider.health(), doctor: await provider.doctor(),
      pluginHealth: await plugin.health!(), pluginDiagnostics: await plugin.diagnostics!(),
    };
    expect(reports.health.status).toBe('degraded');
    expect(reports.doctor).toContainEqual({ check: 'google-credentials', ok: false, detail: expect.stringMatching(/could not read/i) });
    expect(reports.pluginHealth.status).toBe('degraded');
    expect(reports.pluginDiagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(reports)).not.toMatch(/SYNTHETIC|selected@example.test/);
    expect(account.resolveAccount).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['fresh', 'missing', 'expired', 'malformed', 'unreadable'] as const)('integrates real Google metadata for %s through builtin inventory', async state => {
    const now = 1_800_000_000_000;
    const saved = JSON.stringify({
      subject: 'SYNTHETIC_SUBJECT', email: 'selected@example.test', clientId: 'synthetic.apps.googleusercontent.com',
      clientSecret: 'SYNTHETIC_CLIENT_SECRET', accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
      expiresAt: state === 'expired' ? now - 1 : now + 3_600_000, scopes: ['openid', 'email', GMAIL_SEND_SCOPE],
    });
    const store = {
      read: vi.fn(async () => {
        if (state === 'unreadable') throw new Error(saved);
        return state === 'missing' ? undefined : state === 'malformed' ? 'SYNTHETIC_RAW_RECORD' : saved;
      }),
      write: vi.fn(), remove: vi.fn(),
    };
    const transport = vi.fn();
    const account = new GoogleOAuthCredentialProvider({ store, now: () => now, fetch: transport });
    const resolve = vi.spyOn(account, 'resolveAccount');
    const provider = new GmailNotificationProvider({ credentials: account, fetch: transport });
    const plugins = createBuiltinCapabilityPlugins({ credentials: [account], notifications: [provider] });
    const reports = await Promise.all(plugins.map(async plugin => ({ health: await plugin.health!(), diagnostics: await plugin.diagnostics!() })));
    expect(reports.map(report => report.health.status)).toEqual(Array(2).fill(state === 'fresh' ? 'healthy' : state === 'missing' ? 'unhealthy' : 'degraded'));
    expect(reports.every(report => report.diagnostics.length === 0)).toBe(state === 'fresh');
    expect(JSON.stringify(reports)).not.toMatch(/SYNTHETIC|selected@example.test|synthetic.apps.googleusercontent.com/);
    expect(resolve).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['ok', 'degraded', 'unavailable'] as const)('uses injected credential metadata with status %s without resolving tokens', async status => {
    const account = { ...credentials(), health: vi.fn(async () => ({ status, message: 'SYNTHETIC_PRIVATE_METADATA selected@example.test' })) };
    const transport = vi.fn();
    const provider = new GmailNotificationProvider({ credentials: account, fetch: transport });
    const health = await provider.health();
    const diagnostics = await provider.doctor();
    expect(health.status).toBe(status);
    expect(diagnostics.find(finding => finding.check === 'google-credentials')?.ok).toBe(status === 'ok');
    expect(health.message).toMatch(/live.*not.*validated/i);
    expect(JSON.stringify(diagnostics)).toMatch(/Gmail API.*sending permission.*not.*validated/i);
    if (status === 'degraded') expect(health.message).toMatch(/refreshable.*plugin doctor --plugin credential.google-oauth/i);
    expect(JSON.stringify({ health, diagnostics })).not.toMatch(/SYNTHETIC|selected@example.test/);
    expect(account.resolveAccount).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    const plugins = createBuiltinCapabilityPlugins({ notifications: [provider] });
    expect(await plugins[0].health!()).toMatchObject({ status: status === 'ok' ? 'healthy' : status === 'unavailable' ? 'unhealthy' : 'degraded' });
  });

  it('reports an unknown metadata boundary when an injected sender has no passive probe', async () => {
    const account = credentials();
    const transport = vi.fn();
    const provider = new GmailNotificationProvider({ credentials: account, fetch: transport });
    expect(await provider.health()).toMatchObject({ status: 'degraded', message: expect.stringMatching(/metadata.*unavailable.*unknown/i) });
    expect(await provider.doctor()).toContainEqual({ check: 'google-credentials', ok: false, detail: expect.stringMatching(/unknown/i) });
    expect(account.resolveAccount).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('sanitizes probe errors and forwards operation cancellation', async () => {
    const account = { ...credentials(), health: vi.fn(async () => { throw new Error('SYNTHETIC_ACCESS selected@example.test'); }) };
    const provider = new GmailNotificationProvider({ credentials: account, fetch: vi.fn() });
    const health = await provider.health();
    const diagnostics = await provider.doctor();
    expect(health).toMatchObject({ status: 'degraded', message: expect.stringMatching(/could not.*metadata/i) });
    expect(JSON.stringify({ health, diagnostics })).not.toMatch(/SYNTHETIC|selected@example.test/);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    account.health.mockClear();
    await expect(provider.health({ signal: controller.signal })).rejects.toThrow('cancelled');
    await expect(provider.doctor({ signal: controller.signal })).rejects.toThrow('cancelled');
    expect(account.health).not.toHaveBeenCalled();
    expect(account.resolveAccount).not.toHaveBeenCalled();
  });
});

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
