import { describe, expect, it } from 'vitest';
import { compareVersions, parseLatestRelease } from './update.js';

describe('AFK update version handling', () => {
  it.each([
    ['0.1.10', '0.1.2', 1],
    ['1.0.0', '0.99.99', 1],
    ['0.1.2', '0.1.2', 0],
    ['0.1.1', '0.1.2', -1],
  ])('compares %s with %s', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });

  it('extracts a stable version from the latest CLI release tag', () => {
    expect(parseLatestRelease({ tag_name: 'cli-v1.2.3' })).toEqual({
      tag: 'cli-v1.2.3',
      version: '1.2.3',
    });
  });

  it.each([
    null,
    {},
    { tag_name: 'v1.2.3' },
    { tag_name: 'cli-v1.2' },
    { tag_name: 'cli-vlatest' },
    { tag_name: 123 },
  ])('rejects invalid latest release metadata: %j', payload => {
    expect(() => parseLatestRelease(payload)).toThrow();
  });
});
