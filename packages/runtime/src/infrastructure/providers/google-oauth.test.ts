import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMAIL_SEND_SCOPE, GoogleOAuthCredentialProvider } from './google-oauth.js';
import { OAuthKeychainStore, type OAuthSecretStore } from './oauth-keychain.js';
import type { CommandRequest } from './dependencies.js';

const client = { installed: {
  client_id: 'synthetic.apps.googleusercontent.com', client_secret: 'SYNTHETIC_CLIENT_SECRET',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
} };
const scopes = `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SEND_SCOPE}`;
const now = 1_800_000_000_000;
const session = {
  subject: 'user-123', email: 'selected@example.test', clientId: client.installed.client_id,
  clientSecret: client.installed.client_secret, accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
  expiresAt: now + 3_600_000, scopes: scopes.split(' '),
};

function memoryStore(initial?: string) {
  let value = initial;
  return {
    read: vi.fn(async () => value), write: vi.fn(async (next: string) => { value = next; }),
    remove: vi.fn(async () => { value = undefined; }),
  } satisfies OAuthSecretStore;
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('Google browser OAuth', () => {
  let directory: string;
  let clientFile: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'google-oauth-'));
    clientFile = join(directory, 'client.json');
    await writeFile(clientFile, JSON.stringify(client));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each([true, false])('uses a real loopback callback, PKCE and browser-selected identity (scope reported: %s)', async scopeReported => {
    const store = memoryStore();
    let authorization: URL;
    let callbackAddress = '';
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/token')) {
        const parameters = new URLSearchParams(String(init?.body));
        expect(parameters.get('grant_type')).toBe('authorization_code');
        expect(parameters.get('redirect_uri')).toBe(callbackAddress);
        expect(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
        return json({ access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: scopeReported ? scopes : undefined });
      }
      expect(String(url)).toBe('https://openidconnect.googleapis.com/v1/userinfo');
      expect(init?.headers).toEqual({ authorization: 'Bearer SYNTHETIC_ACCESS' });
      return json({ sub: 'user-123', email: 'selected@example.test', email_verified: true });
    });
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: transport, now: () => now, openBrowser: async url => {
      authorization = new URL(url);
      expect(authorization.origin).toBe('https://accounts.google.com');
      expect(authorization.searchParams.get('login_hint')).toBeNull();
      expect(authorization.searchParams.get('access_type')).toBe('offline');
      expect(authorization.searchParams.get('prompt')).toBe('consent select_account');
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      callbackAddress = authorization.searchParams.get('redirect_uri')!;
      const callback = new URL(callbackAddress);
      expect(callback.hostname).toBe('127.0.0.1');
      callback.search = new URLSearchParams({ code: 'SYNTHETIC_CODE', state: 'wrong' }).toString();
      expect((await fetch(callback)).status).toBe(400);
      expect(transport).not.toHaveBeenCalled();
      callback.searchParams.set('state', authorization.searchParams.get('state')!);
      const response = await fetch(callback);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('completed');
    } });
    expect(await provider.login(clientFile)).toEqual({ subject: 'user-123', email: 'selected@example.test' });
    expect(JSON.parse((await store.read())!)).toEqual({ ...session, scopes: scopeReported ? session.scopes : ['openid', 'email', GMAIL_SEND_SCOPE] });
    expect(await provider.status()).toEqual({ connected: true, email: 'selected@example.test', expiresAt: new Date(session.expiresAt).toISOString() });
    await expect(fetch(callbackAddress)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('ignores callbacks with the wrong path and closes the server after consent denial', async () => {
    const store = memoryStore();
    const transport = vi.fn();
    let callbackAddress = '';
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: transport, openBrowser: async url => {
      const authorization = new URL(url);
      callbackAddress = authorization.searchParams.get('redirect_uri')!;
      const callback = new URL(callbackAddress);
      expect((await fetch(new URL('/unrelated', callback))).status).toBe(404);
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, error: 'access_denied' }).toString();
      expect((await fetch(callback)).status).toBe(400);
    } });
    await expect(provider.login(clientFile)).rejects.toThrow('declined');
    expect(store.write).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    await expect(fetch(callbackAddress)).rejects.toThrow();
  });

  it.each(['partial-consent', 'missing-refresh', 'unverified-email', 'keychain-unavailable'])('does not replace the saved account after %s', async failure => {
    const store = memoryStore(JSON.stringify(session));
    if (failure === 'keychain-unavailable') store.write.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_ERROR'));
    const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/token')
      ? json({ access_token: 'SYNTHETIC_NEW_ACCESS', refresh_token: failure === 'missing-refresh' ? undefined : 'SYNTHETIC_NEW_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: failure === 'partial-consent' ? 'openid email' : scopes })
      : json({ sub: 'new-user', email: 'new@example.test', email_verified: failure !== 'unverified-email' }));
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: transport, openBrowser: async url => {
      const authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString();
      const body = await (await fetch(callback)).text();
      if (failure === 'partial-consent') {
        expect(body).toContain('Missing: Send email on your behalf (gmail.send)');
        expect(body).not.toContain('Missing: Google account');
      }
    } });
    const code = { 'partial-consent': 'token.scope', 'missing-refresh': 'token.offline', 'unverified-email': 'account.identity', 'keychain-unavailable': 'account.storage' }[failure];
    await expect(provider.login(clientFile)).rejects.toMatchObject({ name: 'GoogleOAuthError', code });
    expect(await store.read()).toBe(JSON.stringify(session));
  });

  it('cleans up on timeout, cancellation and browser failure', async () => {
    for (const failure of ['timeout', 'cancel', 'browser']) {
      const controller = new AbortController();
      let callbackAddress = '';
      const provider = new GoogleOAuthCredentialProvider({ store: memoryStore(), callbackTimeoutMs: failure === 'cancel' ? 600_000 : 60, openBrowser: async url => {
        callbackAddress = new URL(url).searchParams.get('redirect_uri')!;
        if (failure === 'cancel') controller.abort();
        if (failure === 'browser') throw new Error('SYNTHETIC_PRIVATE_ERROR');
      } });
      const login = provider.login(clientFile, { signal: controller.signal });
      if (failure === 'timeout') await expect(login).rejects.toMatchObject({ name: 'GoogleOAuthError', code: 'authorization.timeout', message: expect.stringContaining('start login again') });
      else await expect(login).rejects.toThrow(/cancelled|Could not open/);
      await expect(fetch(callbackAddress)).rejects.toThrow();
    }
  });

  it('reports a safe network stage when token exchange cannot reach Google', async () => {
    const store = memoryStore();
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: async () => { throw new Error('SYNTHETIC_SECRET_ERROR'); }, openBrowser: async url => {
      const authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString();
      const body = await (await fetch(callback)).text();
      expect(body).toContain('token.network');
      expect(body).not.toContain('SYNTHETIC');
    } });
    await expect(provider.login(clientFile)).rejects.toMatchObject({ name: 'GoogleOAuthError', code: 'token.network' });
    expect(store.write).not.toHaveBeenCalled();
  });

  it('rejects non-desktop and hostile client endpoints before opening the browser', async () => {
    const openBrowser = vi.fn();
    const provider = new GoogleOAuthCredentialProvider({ store: memoryStore(), openBrowser });
    for (const document of [{ web: client.installed }, { installed: { ...client.installed, token_uri: 'https://untrusted.example/token' } }]) {
      await writeFile(clientFile, JSON.stringify(document));
      await expect(provider.login(clientFile)).rejects.toThrow('Desktop app');
    }
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('reuses fresh tokens and refreshes once across concurrent provider instances', async () => {
    const store = memoryStore(JSON.stringify(session));
    const transport = vi.fn(async () => json({ access_token: 'SYNTHETIC_ROTATED_ACCESS', refresh_token: 'SYNTHETIC_ROTATED_REFRESH', token_type: 'Bearer', expires_in: 3600 }));
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: transport, now: () => now });
    expect((await provider.resolve({ name: 'default' })).secret).toBe('SYNTHETIC_ACCESS');
    expect(transport).not.toHaveBeenCalled();
    const expired = new GoogleOAuthCredentialProvider({ store, fetch: transport, now: () => now + 3_600_000 });
    const another = new GoogleOAuthCredentialProvider({ store, fetch: transport, now: () => now + 3_600_000 });
    const tokens = await Promise.all([expired.resolve({ name: 'default' }), another.resolve({ name: 'default' })]);
    expect(tokens.map(value => value.secret)).toEqual(['SYNTHETIC_ROTATED_ACCESS', 'SYNTHETIC_ROTATED_ACCESS']);
    expect(transport).toHaveBeenCalledOnce();
    expect(new URLSearchParams(String(transport.mock.calls[0][1]?.body)).get('grant_type')).toBe('refresh_token');
    expect(JSON.parse((await store.read())!).refreshToken).toBe('SYNTHETIC_ROTATED_REFRESH');
  });

  it('fails closed on unavailable grants, unknown accounts and failed refresh', async () => {
    const store = memoryStore();
    const transport = vi.fn(async () => new Response('SYNTHETIC_SECRET_ERROR', { status: 400 }));
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: transport, now: () => now + 3_600_000 });
    expect(await provider.status()).toEqual({ connected: false });
    await expect(provider.resolve({ name: 'default' })).rejects.toThrow('not connected');
    await store.write(JSON.stringify(session));
    await expect(provider.resolve({ name: 'other' })).rejects.toThrow('Unknown');
    await expect(provider.resolve({ name: 'default', scope: 'ungranted' })).rejects.toThrow('scope');
    await expect(provider.resolve({ name: 'default' })).rejects.toThrow('token exchange failed');
    expect(await store.read()).toBe(JSON.stringify(session));
  });

  it('revokes remotely before removing the local token and supports repeated logout', async () => {
    const store = memoryStore(JSON.stringify(session));
    const transport = vi.fn(async () => new Response('', { status: 200 }));
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: transport });
    await provider.logout();
    await provider.logout();
    expect(transport).toHaveBeenCalledOnce();
    expect(String(transport.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(transport.mock.calls[0][1]?.body)).toBe('token=SYNTHETIC_REFRESH');
    expect(await provider.status()).toEqual({ connected: false });
  });

  it('holds the account lock for the full browser login and rejects another process instance', async () => {
    const store = memoryStore();
    const controller = new AbortController();
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    const provider = new GoogleOAuthCredentialProvider({ store, homeDir: directory, openBrowser: async () => { opened(); } });
    const login = provider.login(clientFile, { signal: controller.signal });
    void login.catch(() => undefined);
    try {
      await ready;
      vi.resetModules();
      const independent = await import('./google-oauth.js');
      const another = new independent.GoogleOAuthCredentialProvider({ store, homeDir: directory });
      await expect(another.logout()).rejects.toThrow('Another Google authentication');
      await expect(another.resolve({ name: 'default' })).rejects.toThrow('Another Google authentication');
      expect(await provider.status()).toEqual({ connected: false });
    } finally {
      controller.abort();
      await expect(login).rejects.toThrow('cancelled');
    }
    await provider.logout();
  });

  it('completes queued logout after browser login so a late callback cannot restore the session', async () => {
    const store = memoryStore();
    const controller = new AbortController();
    let authorization!: URL;
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    const transport = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/token')) return json({ access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: scopes });
      if (String(url).endsWith('/revoke')) return new Response('');
      return json({ sub: 'user-123', email: 'selected@example.test', email_verified: true });
    });
    const provider = new GoogleOAuthCredentialProvider({ store, fetch: transport, homeDir: directory, openBrowser: async url => { authorization = new URL(url); opened(); } });
    const login = provider.login(clientFile, { signal: controller.signal });
    void login.catch(() => undefined);
    try {
      await ready;
      let loggedOut = false;
      const logout = provider.logout().then(() => { loggedOut = true; });
      await Promise.resolve();
      expect(loggedOut).toBe(false);
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'SYNTHETIC_CODE' }).toString();
      await fetch(callback);
      await login;
      await logout;
      expect(await provider.status()).toEqual({ connected: false });
    } finally { controller.abort(); await login.catch(() => undefined); }
  });
});

describe('OAuth system keychain', () => {
  it.each(['darwin', 'linux'])('passes secrets through stdin and verifies the saved value on %s', async os => {
    const calls: CommandRequest[] = [];
    const stored = JSON.stringify(session);
    let encoded = '';
    const store = new OAuthKeychainStore(async request => {
      calls.push(request);
      if (request.input) encoded = request.input;
      if (request.args[4] === 'remove' || request.args[0] === 'clear') encoded = '';
      if (os === 'darwin') return { stdout: JSON.stringify(request.args[4] === 'read' ? encoded ? { value: encoded } : { missing: true } : { ok: true }), stderr: '' };
      if (!encoded && request.args[0] === 'lookup') throw new Error('Provider command failed (1)');
      return { stdout: encoded ? `${encoded}\n` : '', stderr: '' };
    }, os);
    expect(await store.read()).toBeUndefined();
    await store.write(stored);
    expect(await store.read()).toBe(stored);
    expect(calls.every(request => !request.args.some(argument => argument.includes('SYNTHETIC') || argument.includes(Buffer.from(stored).toString('base64url'))))).toBe(true);
    await store.remove();
    expect(await store.read()).toBeUndefined();
  });

  it('distinguishes missing items from keychain errors and never falls back to files', async () => {
    const unavailable = new OAuthKeychainStore(async () => { throw new Error('Provider command failed (36)'); }, 'darwin');
    await expect(unavailable.read()).rejects.toThrow('unavailable');
    await expect(unavailable.write('SYNTHETIC')).rejects.toThrow('could not save');
    const unsupported = new OAuthKeychainStore(vi.fn(), 'win32');
    await expect(unsupported.write('SYNTHETIC')).rejects.toThrow('requires macOS');
  });
});
