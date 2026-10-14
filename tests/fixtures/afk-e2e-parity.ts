/**
 * Parity fixture for AFK E2E validation.
 * Tests basic numeric parity using JavaScript remainder semantics.
 */

export function isEven(value: number): boolean {
  return value % 2 === 0;
}

export function parityLabel(value: number): 'even' | 'odd' {
  return isEven(value) ? 'even' : 'odd';
}
