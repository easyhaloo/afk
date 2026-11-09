import { platform } from 'node:os';
import type { CredentialProvider, CredentialRef, CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort, executeCommand, requestHttp, type CommandExecutor, type FetchTransport } from './dependencies.js';

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
  readonly clientSecret: string;
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
    required(options.clientSecret, 'client secret');
    if (options.authMethod && !['client_secret_basic', 'client_secret_post'].includes(options.authMethod)) throw new Error('Unsupported client authentication method');
    this.config = { ...options };
  }

  async resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue> {
    checkAbort(options);
    const body = new URLSearchParams({ grant_type: 'client_credentials', ...(ref.scope ? { scope: ref.scope } : {}) });
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
    if (this.config.authMethod === 'client_secret_post') {
      body.set('client_id', this.config.clientId);
      body.set('client_secret', this.config.clientSecret);
    } else {
      const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
      headers.set('authorization', `Basic ${Buffer.from(`${encode(this.config.clientId)}:${encode(this.config.clientSecret)}`).toString('base64')}`);
    }
    const response = await requestHttp(this.config.fetch, this.config.tokenEndpoint, { method: 'POST', headers, body }, { ...options, timeoutMs: this.config.timeoutMs });
    return tokenPayload(await readJson(response, options), this.config.now ?? Date.now, ref.scope);
  }
}

export type ClientAssertion = string | ((ref: CredentialRef, tokenEndpoint: string) => string | Promise<string>);

export interface TokenExchangeOptions {
  readonly subjectToken: string | ((ref: CredentialRef) => string | Promise<string>);
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

export class OidcCredentialProvider implements CredentialProvider {
  readonly id = 'credential.oidc';
  readonly capabilities = { read: true, rotate: false, 'scoped-token': true } as const;
  private readonly config: OidcCredentialOptions;

  constructor(options: OidcCredentialOptions) {
    httpsEndpoint(options.issuer, true);
    required(options.clientId, 'client ID');
    if (options.tokenEndpoint) httpsEndpoint(options.tokenEndpoint);
    this.config = { ...options, ...(options.exchange ? { exchange: { ...options.exchange } } : {}) };
  }

  async resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue> {
    checkAbort(options);
    const httpOptions = { ...options, timeoutMs: this.config.timeoutMs };
    const discovery = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await requestHttp(this.config.fetch, discovery, { method: 'GET', headers: { accept: 'application/json' } }, httpOptions);
    const value = await readJson(response, options);
    if (!value || typeof value !== 'object') throw new Error('Invalid OIDC discovery document');
    const metadata = value as OidcMetadata;
    if (metadata.issuer !== this.config.issuer || typeof metadata.token_endpoint !== 'string') throw new Error('OIDC discovery issuer or token endpoint mismatch');
    const tokenEndpoint = httpsEndpoint(metadata.token_endpoint);
    if (this.config.tokenEndpoint && this.config.tokenEndpoint !== tokenEndpoint) throw new Error('OIDC token endpoint does not match the configured pin');
    let assertion: string;
    try {
      assertion = required(typeof this.config.assertion === 'function' ? await this.config.assertion(ref, tokenEndpoint) : this.config.assertion, 'client assertion');
    } catch {
      checkAbort(options);
      throw new Error('Client assertion is unavailable');
    }
    checkAbort(options);
    const body = new URLSearchParams({
      grant_type: 'client_credentials', client_id: this.config.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion,
      ...(ref.scope ? { scope: ref.scope } : {}),
    });
    const exchange = this.config.exchange;
    if (exchange) {
      body.set('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
      try {
        body.set('subject_token', required(typeof exchange.subjectToken === 'function' ? await exchange.subjectToken(ref) : exchange.subjectToken, 'subject token'));
      } catch {
        checkAbort(options);
        throw new Error('Subject token is unavailable');
      }
      body.set('subject_token_type', required(exchange.subjectTokenType, 'subject token type'));
      body.set('requested_token_type', 'urn:ietf:params:oauth:token-type:access_token');
      if (exchange.audience) body.set('audience', exchange.audience);
      if (exchange.resource) body.set('resource', exchange.resource);
    }
    checkAbort(options);
    const token = await requestHttp(this.config.fetch, tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, httpOptions);
    return tokenPayload(await readJson(token, options), this.config.now ?? Date.now, ref.scope, Boolean(exchange));
  }
}

export interface EnterpriseCredentialOptions {
  readonly values?: Readonly<Record<string, string>>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly prefix?: string;
}

export class EnterpriseCredentialProvider implements CredentialProvider {
  readonly id = 'credential.enterprise';
  readonly mode = 'environment-credentials' as const;
  readonly capabilities = { read: true, rotate: false, 'scoped-token': false } as const;
  private readonly values: Readonly<Record<string, string>>;
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
    if (typeof secret !== 'string' || !secret) throw new Error('Environment credential is unavailable');
    return { secret };
  }
}
