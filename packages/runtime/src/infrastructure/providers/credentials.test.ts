import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRequest, FetchTransport } from './dependencies.js';
import { EnterpriseCredentialProvider, OAuthCredentialProvider, OidcCredentialProvider, SystemKeychainProvider } from './credentials.js';

const token = { access_token: 'issued-secret', token_type: 'Bearer', expires_in: 60 };
const issuer = 'https://issuer.example/tenant';
const endpoint = 'https://tokens.example/custom/path?tenant=one';
const now = () => Date.parse('2026-11-06T00:00:00Z');
const json = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => { vi.unstubAllGlobals(); });

describe('credential providers', () => {
  it('reads keychain through injected argv without trimming significant secret whitespace', async () => {
    const calls: CommandRequest[] = [];
    const provider = new SystemKeychainProvider({ command: 'keyring', args: ref => ['get', ref.name], execute: async request => { calls.push(request); return { stdout: ' secret-value \n', stderr: '' }; } });
    await expect(provider.resolve({ name: 'github' })).resolves.toEqual({ secret: ' secret-value ' });
    expect(calls[0].args).toEqual(['get', 'github']);
  });

  it('sanitizes keychain failures and checks cancellation before injected executor', async () => {
    const execute = vi.fn(async () => { throw new Error('sensitive keychain output'); });
    const provider = new SystemKeychainProvider({ execute });
    await expect(provider.resolve({ name: 'github' })).rejects.toThrow('System keychain credential is unavailable');
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(provider.resolve({ name: 'github' }, { signal: controller.signal })).rejects.toThrow('stop');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('sends RFC 6749 client_credentials with encoded Basic authentication and form scope', async () => {
    const fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('client%3Aid:p%3Aa+ss%26').toString('base64')}`);
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toEqual({ grant_type: 'client_credentials', scope: 'read write' });
      expect(body.has('state')).toBe(false);
      expect(body.has('client_secret')).toBe(false);
      return json(token);
    });
    const provider = new OAuthCredentialProvider({ tokenEndpoint: endpoint, clientId: 'client:id', clientSecret: 'p:a ss&', fetch, now });
    await expect(provider.resolve({ name: 'service', scope: 'read write' })).resolves.toEqual({ secret: token.access_token, expiresAt: '2026-11-06T00:01:00.000Z' });
  });

  it('supports explicit client_secret_post without duplicating Basic auth', async () => {
    const fetch: FetchTransport = async (_input, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'client_credentials', client_id: 'client', client_secret: 'secret' });
      return json(token);
    };
    await new OAuthCredentialProvider({ tokenEndpoint: endpoint, clientId: 'client', clientSecret: 'secret', authMethod: 'client_secret_post', fetch }).resolve({ name: 'service' });
  });

  it('uses global fetch lazily and does not perform IO during construction', async () => {
    const fetch = vi.fn(async () => json(token));
    vi.stubGlobal('fetch', fetch);
    const provider = new OAuthCredentialProvider({ tokenEndpoint: endpoint, clientId: 'id', clientSecret: 'secret' });
    expect(fetch).not.toHaveBeenCalled();
    expect((await provider.resolve({ name: 'service' })).secret).toBe(token.access_token);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['http://auth.example/token', 'https://user:secret@auth.example/token', 'https://auth.example/token#fragment', '/token', 'file:///token'])('rejects untrusted OAuth endpoint %s', tokenEndpoint => {
    expect(() => new OAuthCredentialProvider({ tokenEndpoint, clientId: 'client', clientSecret: 'secret' })).toThrow(/HTTPS/);
  });

  it.each([
    {}, { ...token, access_token: '' }, { ...token, token_type: 'DPoP' }, { ...token, expires_in: -1 },
    { ...token, expires_in: '60' }, { ...token, error: 'invalid_client', error_description: 'secret' },
    { ...token, scope: 'read' }, { ...token, access_token: 'line\nbreak' },
  ])('rejects malformed, expired or insufficient token responses without exposing values', async payload => {
    const provider = new OAuthCredentialProvider({ tokenEndpoint: endpoint, clientId: 'client', clientSecret: 'secret', fetch: async () => json(payload) });
    await expect(provider.resolve({ name: 'service', scope: 'write' })).rejects.toThrow(/Credential endpoint/);
  });

  it('sanitizes invalid JSON, HTTP errors and transport exceptions', async () => {
    for (const fetch of [async () => new Response('secret'), async () => new Response('secret', { status: 401 }), async () => { throw new Error('secret'); }]) {
      const provider = new OAuthCredentialProvider({ tokenEndpoint: endpoint, clientId: 'client', clientSecret: 'secret', fetch });
      await expect(provider.resolve({ name: 'service' })).rejects.not.toThrow('secret');
    }
  });

  it('discovers the exact issuer token endpoint and posts standard RFC 7523 assertion form', async () => {
    const assertion = vi.fn(async (_ref, audience: string) => { expect(audience).toBe(endpoint); return 'signed.jwt.assertion'; });
    const calls: string[] = [];
    const fetch: FetchTransport = async (input, init) => {
      calls.push(String(input));
      if (calls.length === 1) {
        expect(init?.method).toBe('GET');
        return json({ issuer, token_endpoint: endpoint });
      }
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'client_credentials', client_id: 'id', client_assertion: 'signed.jwt.assertion',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', scope: 'read',
      });
      return json(token);
    };
    const provider = new OidcCredentialProvider({ issuer, clientId: 'id', assertion, fetch, now });
    expect(assertion).not.toHaveBeenCalled();
    await expect(provider.resolve({ name: 'service', scope: 'read' })).resolves.toEqual({ secret: token.access_token, expiresAt: '2026-11-06T00:01:00.000Z' });
    expect(calls).toEqual([`${issuer}/.well-known/openid-configuration`, endpoint]);
  });

  it('uses RFC 8693 token exchange with client assertion authentication', async () => {
    const fetch: FetchTransport = async (_input, init) => {
      if (init?.method === 'GET') return json({ issuer, token_endpoint: endpoint });
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      expect(form).toMatchObject({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: 'subject-secret',
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: 'service', resource: 'https://resource.example', client_assertion: 'signed.jwt.assertion',
      });
      return json({ ...token, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' });
    };
    const provider = new OidcCredentialProvider({ issuer, clientId: 'id', assertion: 'signed.jwt.assertion', fetch,
      exchange: { subjectToken: async () => 'subject-secret', subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token', audience: 'service', resource: 'https://resource.example' } });
    expect((await provider.resolve({ name: 'service' })).secret).toBe(token.access_token);
  });

  it.each([
    { issuer: 'https://wrong.example', token_endpoint: endpoint }, { issuer, token_endpoint: 'http://auth.example/token' },
    { issuer, token_endpoint: 'https://user:secret@auth.example/token' }, { issuer }, { issuer: `${issuer}/`, token_endpoint: endpoint },
  ])('rejects untrusted discovery before generating or sending an assertion', async metadata => {
    const fetch = vi.fn(async () => json(metadata));
    const assertion = vi.fn(() => 'signed.jwt.assertion');
    const provider = new OidcCredentialProvider({ issuer, clientId: 'id', assertion, fetch });
    await expect(provider.resolve({ name: 'service' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(assertion).not.toHaveBeenCalled();
  });

  it('pins configured token endpoints instead of overriding discovery', async () => {
    const fetch = vi.fn(async () => json({ issuer, token_endpoint: endpoint }));
    await expect(new OidcCredentialProvider({ issuer, clientId: 'id', assertion: 'jwt', tokenEndpoint: 'https://other.example/token', fetch }).resolve({ name: 'service' })).rejects.toThrow('configured pin');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('sanitizes assertion and subject-token callback failures', async () => {
    const fetch = vi.fn(async () => json({ issuer, token_endpoint: endpoint }));
    const failed = () => { throw new Error('private-key-secret'); };
    await expect(new OidcCredentialProvider({ issuer, clientId: 'id', assertion: failed, fetch }).resolve({ name: 'service' })).rejects.toThrow('Client assertion is unavailable');
    await expect(new OidcCredentialProvider({ issuer, clientId: 'id', assertion: 'jwt', fetch, exchange: { subjectToken: failed, subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token' } }).resolve({ name: 'service' })).rejects.toThrow('Subject token is unavailable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels before token requests if assertion preparation aborts', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => json({ issuer, token_endpoint: endpoint }));
    const provider = new OidcCredentialProvider({ issuer, clientId: 'id', fetch, assertion: async () => {
      controller.abort(new Error('cancel assertion'));
      return 'signed.jwt.assertion';
    } });
    await expect(provider.resolve({ name: 'service' }, { signal: controller.signal })).rejects.toThrow('cancel assertion');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects invalid OIDC issuer URLs and checks cancellation before discovery', async () => {
    for (const invalid of ['http://issuer.example', `${issuer}?query=1`, `${issuer}#fragment`, 'https://user:secret@issuer.example']) {
      expect(() => new OidcCredentialProvider({ issuer: invalid, clientId: 'id', assertion: 'jwt' })).toThrow(/HTTPS/);
    }
    const fetch = vi.fn(async () => json({ issuer, token_endpoint: endpoint }));
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(new OidcCredentialProvider({ issuer, clientId: 'id', assertion: 'jwt', fetch }).resolve({ name: 'service' }, { signal: controller.signal })).rejects.toThrow('stop');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves explicit environment/map credentials and disclaims enterprise token issuance', async () => {
    const provider = new EnterpriseCredentialProvider({ values: { map: 'map-secret' }, environment: { AFK_CREDENTIAL_ENV: 'env-secret' } });
    await expect(provider.resolve({ name: 'map' })).resolves.toEqual({ secret: 'map-secret' });
    await expect(provider.resolve({ name: 'env' })).resolves.toEqual({ secret: 'env-secret' });
    expect(provider.mode).toBe('environment-credentials');
    expect(provider.capabilities['scoped-token']).toBe(false);
    await expect(provider.resolve({ name: 'missing' })).rejects.toThrow('unavailable');
    await expect(provider.resolve({ name: 'map', scope: 'admin' })).rejects.toThrow('cannot issue scoped tokens');
    await expect(provider.resolve({ name: 'env-name' })).rejects.toThrow('Invalid environment credential name');
    await expect(provider.resolve({ name: 'toString' })).rejects.toThrow('unavailable');
  });
});
