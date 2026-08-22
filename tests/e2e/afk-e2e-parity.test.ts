import { describe, it, expect } from 'vitest';
import { isEven } from '../fixtures/afk-e2e-parity.js';

describe('afk-e2e-parity', () => {
  it('isEven(-3) === false', () => {
    expect(isEven(-3)).toBe(false);
  });

  it('isEven(0) === true', () => {
    expect(isEven(0)).toBe(true);
  });

  it('isEven(4) === true', () => {
    expect(isEven(4)).toBe(true);
  });
});
