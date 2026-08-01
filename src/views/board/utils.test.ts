import { describe, it, expect } from 'vitest';
import { visualWidth, truncateByVisualWidth, truncate } from './utils';

describe('visualWidth', () => {
  it('returns 1 per ASCII char', () => {
    expect(visualWidth('abc')).toBe(3);
    expect(visualWidth('hello')).toBe(5);
  });

  it('returns 2 per CJK char', () => {
    expect(visualWidth('中文')).toBe(4);
    expect(visualWidth('测试标签')).toBe(8);
  });

  it('handles mixed content', () => {
    expect(visualWidth('stage::qa')).toBe(9); // s-t-a-g-e-::-q-a = 9
  });
});

describe('truncateByVisualWidth', () => {
  it('returns unchanged string when under max width', () => {
    expect(truncateByVisualWidth('abc', 10)).toBe('abc');
  });

  it('truncates and adds … when exceeding max width', () => {
    // 'abc' (3) + '…' (2) = 5 visual width (max is 5)
    expect(truncateByVisualWidth('abcdefgh', 5)).toBe('abc…');
    expect(visualWidth('abc…')).toBe(5);
  });

  it('handles CJK chars correctly', () => {
    // '中文测试' has visual width 8, max 6 should give '中文…'
    expect(truncateByVisualWidth('中文测试', 6)).toBe('中文…');
  });

  it('handles mixed ASCII and CJK', () => {
    // 'stage::中文' = 8 visual width, leaving room for '…' (2) = total 10
    // So we can fit 'stage::中文' + '…' = 10
    const result = truncateByVisualWidth('stage::中文标签', 10);
    expect(visualWidth(result)).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('truncates long label strings at 20 visual width (issue #40)', () => {
    const longLabels = 'mode::afk, stage::qa, base::prd-33, session::afk-gh-35';
    const result = truncateByVisualWidth(longLabels, 20);
    expect(visualWidth(result)).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('truncate (existing)', () => {
  it('truncates by character count', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
  });
});
