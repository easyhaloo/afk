/**
 * Parity helper for AFK E2E parity fixture.
 * Uses JavaScript remainder semantics for negative, zero, and positive integers.
 */
export function isEven(value: number): boolean {
  return value % 2 === 0;
}
