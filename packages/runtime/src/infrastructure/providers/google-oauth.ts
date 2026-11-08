import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CredentialProvider, CredentialRef, CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { openInBrowser } from '../../shared/browser.js';
import { checkAbort, requestHttp, type FetchTransport } from './dependencies.js';
import { OAuthKeychainStore, type OAuthSecretStore } from './oauth-keychain.js';
import { systemProxyFetch } from './system-proxy-fetch.js';

const oauthErrors = {
  'authorization.timeout': 'Google sign-in timed out and the callback listener closed; start login again and use the newly opened browser page',
  'token.network': 'Cannot reach the Google token endpoint; check the configured network proxy',
  'token.exchange': 'Google token exchange failed; check the Desktop client and authorization permissions',
  'token.scope': 'Google did not grant all requested permissions; authorize mail sending and account identity',
  'token.offline': 'Google did not provide an offline token; authorize again with consent',
  'account.identity': 'Google did not return a verified account identity',
  'account.storage': 'Cannot save Google credentials; unlock the system keychain and retry',
} as const;

export class GoogleOAuthError extends Error {
  readonly missingPermissions: readonly string[];

  constructor(readonly code: keyof typeof oauthErrors, missingScopes: readonly string[] = []) {
    const permissions = code === 'token.scope' ? requestedScopes.filter(scope => missingScopes.includes(scope)).map(scope => scopeLabels[scope]) : [];
    super(`${oauthErrors[code]}${permissions.length ? `. Missing: ${permissions.join(', ')}` : ''}`);
    this.name = 'GoogleOAuthError';
    this.missingPermissions = permissions;
  }
}

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const userinfoEndpoint = 'https://openidconnect.googleapis.com/v1/userinfo';
const revokeEndpoint = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const requestedScopes = ['openid', 'email', GMAIL_SEND_SCOPE];
const scopeLabels: Readonly<Record<string, string>> = { openid: 'Google account identity', email: 'Google account email', [GMAIL_SEND_SCOPE]: 'Send email on your behalf (gmail.send)' };
const secretText = z.string().min(1).max(16384).regex(/^[^\s\0]+$/);
const clientSchema = z.object({
  installed: z.object({
    client_id: z.string().regex(/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/),
    client_secret: secretText,
    auth_uri: z.literal('https://accounts.google.com/o/oauth2/auth'),
    token_uri: z.literal(tokenEndpoint),
  }),
});
const accountSchema = z.object({ subject: z.string().min(1).max(255), email: z.string().email() });
const sessionSchema = accountSchema.extend({
  clientId: clientSchema.shape.installed.shape.client_id,
  clientSecret: secretText,
  accessToken: secretText,
  refreshToken: secretText,
  expiresAt: z.number().int().positive().max(8.64e15),
  scopes: z.array(z.string().min(1)),
});
type GoogleSession = z.infer<typeof sessionSchema>;
export type GoogleAccount = z.infer<typeof accountSchema>;

export interface GoogleOAuthOptions {
  readonly store?: OAuthSecretStore;
  readonly fetch?: FetchTransport;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly callbackTimeoutMs?: number;
  readonly now?: () => number;
  readonly homeDir?: string;
}

function normalizeScope(scope: string): string {
  return scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope;
}

function hasScopes(granted: readonly string[], wanted: readonly string[]): boolean {
  const normalized = new Set(granted.map(normalizeScope));
  return wanted.every(scope => normalized.has(normalizeScope(scope)));
}

export class GoogleOAuthCredentialProvider implements CredentialProvider {
  readonly id = 'credential.google-oauth';
  readonly capabilities = { read: true, rotate: false, 'scoped-token': true } as const;
  private readonly store: OAuthSecretStore;
  private readonly now: () => number;
  private readonly fetch: FetchTransport;
  // ponytail: one default account; partition locks when multiple accounts are supported.
  private static tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GoogleOAuthOptions = {}) {
    this.store = options.store ?? new OAuthKeychainStore();
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? systemProxyFetch;
  }

  private locked<Result>(operation: () => Promise<Result>, options?: ProviderOperationOptions): Promise<Result> {
    const guarded = async () => {
      checkAbort(options);
      const directory = join(this.options.homeDir ?? homedir(), '.afk', 'auth');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'google-oauth.lock');
      let lock;
      try { lock = await open(path, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another Google authentication operation is running; retry after it finishes');
        throw new Error('Google authentication lock is unavailable');
      }
      try { await lock.writeFile(`${process.pid}\n`); checkAbort(options); return await operation(); }
      finally { try { await lock.close(); } finally { await unlink(path); } }
    };
    const next = GoogleOAuthCredentialProvider.tail.then(guarded, guarded);
    GoogleOAuthCredentialProvider.tail = next.catch(() => undefined);
    return next;
  }

  private async session(options?: ProviderOperationOptions): Promise<GoogleSession | undefined> {
    const text = await this.store.read(options);
    if (text === undefined) return undefined;
    try { return sessionSchema.parse(JSON.parse(text)); }
    catch { throw new Error('Google OAuth account record is invalid; sign in again'); }
  }

  private async token(parameters: URLSearchParams, options?: ProviderOperationOptions, previous?: GoogleSession): Promise<Pick<GoogleSession, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scopes'>> {
    try {
      const response = await requestHttp(this.fetch, tokenEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: parameters.toString(),
      }, options);
      const payload = z.object({
        access_token: secretText, refresh_token: secretText.optional(), token_type: z.string().regex(/^bearer$/i),
        expires_in: z.number().int().positive().max(31_536_000), scope: z.string().optional(),
      }).parse(await response.json());
      const scopes = payload.scope?.split(' ').filter(Boolean) ?? previous?.scopes ?? requestedScopes;
      if (!hasScopes(scopes, requestedScopes)) throw new GoogleOAuthError('token.scope', requestedScopes.filter(scope => !hasScopes(scopes, [scope])));
      const refreshToken = payload.refresh_token ?? previous?.refreshToken;
      if (!refreshToken) throw new GoogleOAuthError('token.offline');
      return { accessToken: payload.access_token, refreshToken, expiresAt: this.now() + payload.expires_in * 1000, scopes };
    } catch (error) {
      checkAbort(options);
      if (error instanceof GoogleOAuthError) throw error;
      if (error instanceof Error && /Provider HTTP (transport failed|request timed out)/.test(error.message)) throw new GoogleOAuthError('token.network');
      throw new GoogleOAuthError('token.exchange');
    }
  }

  async login(clientFile: string, options?: ProviderOperationOptions): Promise<GoogleAccount> {
    return this.locked(() => this.loginInBrowser(clientFile, options), options);
  }

  private async loginInBrowser(clientFile: string, options?: ProviderOperationOptions): Promise<GoogleAccount> {
    checkAbort(options);
    let client: z.infer<typeof clientSchema>['installed'];
    try {
      if ((await stat(clientFile)).size > 65536) throw new Error('Client file is too large');
      client = clientSchema.parse(JSON.parse(await readFile(clientFile, 'utf8'))).installed;
    } catch { throw new Error('Expected a Google Desktop app OAuth client JSON file'); }
    const timeoutMs = this.options.callbackTimeoutMs ?? 600_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) throw new Error('Invalid OAuth callback timeout');
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Google sign-in cancelled'));
    options?.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new GoogleOAuthError('authorization.timeout')), timeoutMs);
    const operation = { signal: controller.signal };
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const callbackPath = `/oauth/callback/${randomBytes(16).toString('hex')}`;
    let redirectUri = '';
    let claimed = false;
    let complete!: (account: GoogleAccount) => void;
    let fail!: (error: Error) => void;
    const result = new Promise<GoogleAccount>((resolve, reject) => { complete = resolve; fail = reject; });
    void result.catch(() => undefined);
    const interrupted = () => fail(controller.signal.reason as Error);
    controller.signal.addEventListener('abort', interrupted, { once: true });
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-content-type-options', 'nosniff');
      let callback: URL;
      try { callback = new URL(request.url ?? '/', 'http://127.0.0.1'); }
      catch { response.writeHead(400).end('Invalid callback'); return; }
      const candidate = Buffer.from(callback.searchParams.get('state') ?? '');
      if (request.method !== 'GET' || callback.pathname !== callbackPath || request.headers.host !== new URL(redirectUri).host) {
        response.writeHead(404).end('Not found'); return;
      }
      if (candidate.length !== state.length || !timingSafeEqual(candidate, Buffer.from(state)) || callback.searchParams.getAll('state').length !== 1) {
        response.writeHead(400).end('Invalid authorization state'); return;
      }
      if (claimed) { response.writeHead(409).end('Authorization callback already received'); return; }
      claimed = true;
      if (callback.searchParams.has('error') || callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code')) {
        response.writeHead(400).end('Authorization was declined. Return to AFK to retry.');
        fail(new Error('Google authorization was declined or returned an invalid callback')); return;
      }
      void (async () => {
        checkAbort(operation);
        const tokens = await this.token(new URLSearchParams({
          grant_type: 'authorization_code', code: callback.searchParams.get('code')!,
          redirect_uri: redirectUri, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier,
        }), operation);
        let account: GoogleAccount;
        try {
          const profile = await requestHttp(this.fetch, userinfoEndpoint, { headers: { authorization: `Bearer ${tokens.accessToken}` } }, operation);
          const identity = z.object({ sub: z.string().min(1).max(255), email: z.string().email(), email_verified: z.literal(true) }).parse(await profile.json());
          account = { subject: identity.sub, email: identity.email };
        } catch { checkAbort(operation); throw new GoogleOAuthError('account.identity'); }
        checkAbort(operation);
        try { await this.store.write(JSON.stringify({ ...tokens, ...account, clientId: client.client_id, clientSecret: client.client_secret }), operation); }
        catch { checkAbort(operation); throw new GoogleOAuthError('account.storage'); }
        return account;
      })().then(account => {
        response.end('Google sign-in completed. You can close this tab and return to AFK.');
        complete(account);
      }, error => {
        const diagnostic = error instanceof GoogleOAuthError ? error : new GoogleOAuthError('token.exchange');
        response.writeHead(500).end(`Google sign-in failed (${diagnostic.code}). ${diagnostic.message}. Return to AFK to retry.`);
        fail(diagnostic);
      });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    try {
      if (options?.signal?.aborted) abort();
      checkAbort(operation);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not start the OAuth callback listener');
      redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`;
      const authorization = new URL(authorizationEndpoint);
      authorization.search = new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
        scope: requestedScopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account',
      }).toString();
      const opening = (this.options.openBrowser ?? openInBrowser)(authorization.toString()).catch(() => {
        throw new Error('Could not open the browser for Google sign-in');
      });
      return await Promise.race([result, opening.then(() => result)]);
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', interrupted);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  async status(): Promise<{ connected: boolean; email?: string; expiresAt?: string }> {
    const session = await this.session();
    return session ? { connected: true, email: session.email, expiresAt: new Date(session.expiresAt).toISOString() } : { connected: false };
  }

  async resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue> {
    if (ref.name !== 'default') throw new Error('Unknown Google OAuth account reference');
    const session = await this.authorizedSession(ref.scope, options);
    return { secret: session.accessToken, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  async resolveAccount(options?: ProviderOperationOptions): Promise<CredentialValue & GoogleAccount> {
    const session = await this.authorizedSession(GMAIL_SEND_SCOPE, options);
    return { secret: session.accessToken, expiresAt: new Date(session.expiresAt).toISOString(), subject: session.subject, email: session.email };
  }

  private authorizedSession(scope?: string, options?: ProviderOperationOptions): Promise<GoogleSession> {
    return this.locked(async () => {
      checkAbort(options);
      let session = await this.session(options);
      if (!session) throw new Error('Google account is not connected; run plugin auth login google');
      if (!hasScopes(session.scopes, requestedScopes) || (scope && !hasScopes(session.scopes, scope.split(' ').filter(Boolean)))) {
        throw new Error('Google account does not grant the requested scope; sign in again');
      }
      if (session.expiresAt <= this.now() + 60_000) {
        const tokens = await this.token(new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: session.refreshToken,
          client_id: session.clientId, client_secret: session.clientSecret,
        }), options, session);
        session = { ...session, ...tokens };
        await this.store.write(JSON.stringify(session), options);
      }
      return session;
    }, options);
  }

  async logout(options?: ProviderOperationOptions): Promise<void> {
    await this.locked(async () => {
      checkAbort(options);
      const session = await this.session(options);
      if (!session) return;
      await requestHttp(this.fetch, revokeEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: session.refreshToken }).toString(),
      }, options);
      await this.store.remove(options);
    }, options);
  }
}
