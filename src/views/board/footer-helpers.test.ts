import { describe, it, expect } from 'vitest';
import { formatPathLabel } from './footer-helpers';

describe('formatPathLabel (AC1: ~/path (branch) format)', () => {
  it('combines path and branch into ~/path (branch) format', () => {
    expect(formatPathLabel('~/repo', 'feature-x')).toBe('~/repo (feature-x)');
  });

  it('keeps the main branch inside parens', () => {
    expect(formatPathLabel('~/work/proj', 'main')).toBe('~/work/proj (main)');
  });
});
