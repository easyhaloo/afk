import { describe, expect, it } from 'vitest';
import { isEven, parityLabel } from '../fixtures/afk-e2e-parity.js';

describe('AFK E2E parity fixture', () => {
  it('isEven(-3) === false', () => {
    expect(isEven(-3)).toBe(false);
  });

  it('isEven(0) === true', () => {
    expect(isEven(0)).toBe(true);
  });

  it('isEven(4) === true', () => {
    expect(isEven(4)).toBe(true);
  });

  it('parityLabel(8) === "even"', () => {
    expect(parityLabel(8)).toBe('even');
  });

  it('parityLabel(-1) === "odd"', () => {
    expect(parityLabel(-1)).toBe('odd');
  });
});
