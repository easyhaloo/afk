import { describe, expect, it } from 'vitest';
import { HostFailure, HOST_FAILURE_SUGGESTIONS } from './ports.js';

describe('HostFailure', () => {
  it('keeps a stable category and actionable suggestion', () => {
    const failure = new HostFailure('auth-required', 'credentials expired');
    expect(failure).toMatchObject({ name: 'HostFailure', code: 'auth-required' });
    expect(failure.suggestion).toContain('凭据');
  });

  it('covers every failure code with a non-empty suggestion', () => {
    const codes = ['binary-missing', 'server-unknown', 'auth-required', 'asset-unknown', 'unreachable', 'remote-failed'] as const;
    for (const code of codes) {
      const failure = new HostFailure(code, `detail for ${code}`);
      expect(failure.code).toBe(code);
      expect(failure.suggestion).toBe(HOST_FAILURE_SUGGESTIONS[code]);
      expect(failure.suggestion.length).toBeGreaterThan(0);
      expect(failure.message).toBe(`detail for ${code}`);
    }
  });

  it('preserves the underlying cause', () => {
    const cause = new Error('enoent');
    const failure = new HostFailure('binary-missing', 'missing', { cause });
    expect(failure.cause).toBe(cause);
  });
});
