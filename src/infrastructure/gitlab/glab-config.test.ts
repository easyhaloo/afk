import { describe, expect, it } from 'vitest';
import { listGlabTokens } from './glab-config';

describe('glab token catalog', () => {
  it('returns every configured host with a token in stable order', () => {
    expect(listGlabTokens({
      host: 'gitlab.com',
      hosts: {
        'z.corp': { api_host: 'git.z.corp', api_protocol: 'https', token: 'z-token' },
        'gitlab.com': { api_host: 'gitlab.com', api_protocol: 'https', token: 'public-token' },
        'missing.example': { api_host: 'missing.example', api_protocol: 'https' },
      },
    })).toEqual([
      { host: 'gitlab.com', apiHost: 'gitlab.com', apiProtocol: 'https', token: 'public-token' },
      { host: 'z.corp', apiHost: 'git.z.corp', apiProtocol: 'https', token: 'z-token' },
    ]);
  });
});
