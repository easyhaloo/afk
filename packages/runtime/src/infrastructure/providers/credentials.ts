import { platform } from 'node:os';
import type { CredentialProvider, CredentialRef, CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort, executeCommand, requestHttp, type CommandExecutor, type FetchTransport } from './dependencies.js';
import { resolveOperationCredential, resolveOperationSecret, validateOperationCredential, type OperationSecret } from './operation-secret.js';

function httpsEndpoint(value: string, issuer = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Credential endpoint must be an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || value.includes('#') || (issuer && value.includes('?'))) {
    throw new Error('Credential endpoint must use HTTPS without embedded credentials, fragments or issuer queries');
  }
  return value;
}

function required(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  error?: unknown;
  scope?: unknown;
  issued_token_type?: unknown;
}

async function readJson(response: Response, options?: ProviderOperationOptions): Promise<unknown> {
  checkAbort(options);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error('Credential endpoint returned invalid JSON'); }
  checkAbort(options);
  return payload;
}

function tokenPayload(value: unknown, now: () => number, scope?: string, exchange = false): CredentialValue {
  if (!value || typeof value !== 'object') throw new Error('Credential endpoint returned an invalid token response');
  const payload = value as TokenResponse;
  if (payload.error !== undefined || typeof payload.access_token !== 'string' || !payload.access_token || /\s/.test(payload.access_token)
    || typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer'
    || (exchange && payload.issued_token_type !== 'urn:ietf:params:oauth:token-type:access_token')) {
    throw new Error('Credential endpoint returned an invalid bearer token response');
  }
  if (payload.scope !== undefined && (typeof payload.scope !== 'string' || (scope ?? '').split(' ').filter(Boolean).some(token => !(payload.scope as string).split(' ').includes(token)))) {
    throw new Error('Credential endpoint did not grant the requested scope');
  }
  if (payload.expires_in === undefined) return { secret: payload.access_token };
  if (typeof payload.expires_in !== 'number' || !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= 0) throw new Error('Credential endpoint returned an invalid token lifetime');
  const expiration = now() + payload.expires_in * 1000;
  if (!Number.isFinite(expiration) || expiration > 8.64e15) throw new Error('Credential endpoint returned an invalid token lifetime');
  return { secret: payload.access_token, expiresAt: new Date(expiration).toISOString() };
}

export interface SystemKeychainOptions {
  readonly service?: string;
  readonly command?: string;
  readonly args?: (ref: CredentialRef) => readonly string[];
  readonly execute?: CommandExecutor;
}

export class SystemKeychainProvider implements CredentialProvider {
  readonly id = 'credential.system-keychain';
  readonly capabilities = { read: true, rotate: false, 'scoped-token': false } as const;
  private readonly command: string;
  private readonly args: (ref: CredentialRef) => readonly string[];
  private readonly execute: CommandExecutor;

  constructor(options: SystemKeychainOptions = {}) {
    this.command = options.command ?? (platform() === 'darwin' ? 'security' : 'secret-tool');
    this.args = options.args ?? (ref => platform() === 'darwin' ? ['find-generic-password', '-s', options.service ?? 'afk', '-a', ref.name, '-w'] : ['lookup', 'service', options.service ?? 'afk', 'account', ref.name]);
    this.execute = options.execute ?? executeCommand;
  }

  async resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue> {
    checkAbort(options);
    required(ref.name, 'credential name');
    if (ref.scope) throw new Error('System keychain credentials do not support token scopes');
    try {
      const result = await this.execute({ command: this.command, args: [...this.args(ref)], signal: options?.signal });
      checkAbort(options);
      const secret = result.stdout.replace(/\r?\n$/, '');
      if (!secret) throw new Error('empty');
      return { secret };
    } catch {
      checkAbort(options);
      throw new Error('System keychain credential is unavailable');
    }
  }
}

export interface OAuthCredentialOptions {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: OperationSecret;
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
  readonly fetch?: FetchTransport;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class OAuthCredentialProvider implements CredentialProvider {
  readonly id = 'credential.oauth';
  readonly capabilities = { read: true, rotate: false, 'scoped-token': true } as const;
  private readonly config: OAuthCredentialOptions;

  constructor(options: OAuthCredentialOptions) {
    httpsEndpoint(options.tokenEndpoint);
    required(options.clientId, 'client ID');
    if (typeof options.clientSecret === 'string') required(options.clientSecret, 'client secret');
    if (options.authMethod && !['client_secret_basic', 'client_secret_post'].includes(options.authMethod)) throw new Error('Unsupported client authentication method');
    this.config = { ...options };
  }

  async resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue> {
    checkAbort(options);
    const clientSecret = await resolveOperationSecret(this.config.clientSecret, options);
    const body = new URLSearchParams({ grant_type: 'client_credentials', ...(ref.scope ? { scope: ref.scope } : {}) });
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
    if (this.config.authMethod === 'client_secret_post') {
      body.set('client_id', this.config.clientId);
      body.set('client_secret', clientSecret);
    } else {
      const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
      headers.set('authorization', `Basic ${Buffer.from(`${encode(this.config.clientId)}:${encode(clientSecret)}`).toString('base64')}`);
    }
    const response = await requestHttp(this.config.fetch, this.config.tokenEndpoint, { method: 'POST', headers, body }, { ...options, timeoutMs: this.config.timeoutMs });
    return tokenPayload(await readJson(response, options), this.config.now ?? Date.now, ref.scope);
  }
}

export type ClientAssertion = string | ((ref: CredentialRef, tokenEndpoint: string, options?: ProviderOperationOptions) => string | CredentialValue | Promise<string | CredentialValue>);

export interface TokenExchangeOptions {
  readonly subjectToken: string | ((ref: CredentialRef, options?: ProviderOperationOptions) => string | CredentialValue | Promise<string | CredentialValue>);
  readonly subjectTokenType: string;
  readonly audience?: string;
  readonly resource?: string;
}

export interface OidcCredentialOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly assertion: ClientAssertion;
  readonly tokenEndpoint?: string;
  readonly exchange?: TokenExchangeOptions;
  readonly fetch?: FetchTransport;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface OidcMetadata {
  issuer?: unknown;
  token_endpoint?: unknown;
}

async function resolveOidcInput(input: () => string | CredentialValue | Promise<string | CredentialValue>, options: ProviderOperationOptions): Promise<CredentialValue> {
  return resolveOperationCredential(async () => {
    const value = await input();
    return typeof value === 'string' ? { secret: value } : value;
  }, options);
}

export class OidcCredentialProvider implements CredentialProvider {
  readonly id = 'credential.oidc';
  readonly capabilities = { read: true, rotate: false, 'scoped-token': true } as const;
  private readonly config: OidcCredentialOptions;
  private readonly lifetime = new AbortController();

  constructor(options: OidcCredentialOptions) {
    httpsEndpoint(options.issuer, true);
    required(options.clientId, 'client ID');
    if (options.tokenEndpoint) httpsEndpoint(options.tokenEndpoint);
    this.config = { ...options, ...(options.exchange ? { exchange: { ...options.exchange } } : {}) };
  }

  async resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue> {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('OIDC operation unavailable'));
    options?.signal?.addEventListener('abort', abort, { once: true });
    this.lifetime.signal.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted || this.lifetime.signal.aborted) abort();
    try {
      return await this.resolveOperation(ref, { ...options, signal: controller.signal });
    } finally {
      options?.signal?.removeEventListener('abort', abort);
      this.lifetime.signal.removeEventListener('abort', abort);
    }
  }

  private async resolveOperation(ref: CredentialRef, options: ProviderOperationOptions): Promise<CredentialValue> {
    checkAbort(options);
    const timeoutMs = this.config.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error('Invalid HTTP timeout');
    let operation = { ...options, timeoutMs, deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + timeoutMs) };
    checkAbort(operation);
    const discovery = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await requestHttp(this.config.fetch, discovery, { method: 'GET', headers: { accept: 'application/json' } }, operation);
    const value = await readJson(response, operation);
    if (!value || typeof value !== 'object') throw new Error('Invalid OIDC discovery document');
    const metadata = value as OidcMetadata;
    if (metadata.issuer !== this.config.issuer || typeof metadata.token_endpoint !== 'string') throw new Error('OIDC discovery issuer or token endpoint mismatch');
    const tokenEndpoint = httpsEndpoint(metadata.token_endpoint);
    if (this.config.tokenEndpoint && this.config.tokenEndpoint !== tokenEndpoint) throw new Error('OIDC token endpoint does not match the configured pin');
    let assertion: CredentialValue;
    try {
      const source = this.config.assertion;
      assertion = await resolveOidcInput(() => typeof source === 'function' ? source(ref, tokenEndpoint, operation) : source, operation);
    } catch {
      checkAbort(options);
      throw new Error('Client assertion is unavailable');
    }
    if (assertion.expiresAt !== undefined) operation = { ...operation, deadlineAt: Math.min(operation.deadlineAt, Date.parse(assertion.expiresAt)) };
    checkAbort(operation);
    const body = new URLSearchParams({
      grant_type: 'client_credentials', client_id: this.config.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion.secret,
      ...(ref.scope ? { scope: ref.scope } : {}),
    });
    const exchange = this.config.exchange;
    let subject: CredentialValue | undefined;
    if (exchange) {
      body.set('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
      try {
        const source = exchange.subjectToken;
        subject = await resolveOidcInput(() => typeof source === 'function' ? source(ref, operation) : source, operation);
        body.set('subject_token', subject.secret);
      } catch {
        checkAbort(options);
        throw new Error('Subject token is unavailable');
      }
      if (subject.expiresAt !== undefined) operation = { ...operation, deadlineAt: Math.min(operation.deadlineAt, Date.parse(subject.expiresAt)) };
      body.set('subject_token_type', required(exchange.subjectTokenType, 'subject token type'));
      body.set('requested_token_type', 'urn:ietf:params:oauth:token-type:access_token');
      if (exchange.audience) body.set('audience', exchange.audience);
      if (exchange.resource) body.set('resource', exchange.resource);
    }
    validateOperationCredential(assertion);
    if (subject) validateOperationCredential(subject);
    checkAbort(operation);
    const token = await requestHttp(this.config.fetch, tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, operation);
    const payload = await readJson(token, operation);
    validateOperationCredential(assertion);
    if (subject) validateOperationCredential(subject);
    return tokenPayload(payload, this.config.now ?? Date.now, ref.scope, Boolean(exchange));
  }

  dispose(): void { this.lifetime.abort(new Error('OIDC operation unavailable')); }
}

export interface EnterpriseCredentialOptions {
  readonly values?: Readonly<Record<string, OperationSecret>>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly prefix?: string;
}

export class EnterpriseCredentialProvider implements CredentialProvider {
  readonly id = 'credential.enterprise';
  readonly mode = 'environment-credentials' as const;
  readonly capabilities = { read: true, rotate: false, 'scoped-token': false } as const;
  private readonly values: Readonly<Record<string, OperationSecret>>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly prefix: string;

  constructor(options: EnterpriseCredentialOptions = {}) {
    this.values = options.values ?? {};
    this.environment = options.environment ?? process.env;
    this.prefix = options.prefix ?? 'AFK_CREDENTIAL_';
  }

  async resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue> {
    checkAbort(options);
    if (ref.scope) throw new Error('Environment credential adapter cannot issue scoped tokens; use an OAuth or OIDC adapter');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(ref.name)) throw new Error('Invalid environment credential name');
    const secret = Object.hasOwn(this.values, ref.name) ? this.values[ref.name] : this.environment[`${this.prefix}${ref.name.toUpperCase()}`];
    if (secret === undefined || secret === '') throw new Error('Environment credential is unavailable');
    return resolveOperationCredential(secret, options);
  }
}
