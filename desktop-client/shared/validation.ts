/**
 * Shared validation helpers extracted from backlog-contract.ts and ssh-contract.ts.
 * These are business-logic validators — not wire-format parsers — so they live
 * here rather than in the wire-format-only shared/ directory.
 */

export function assertExactKeys(candidate: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(candidate)) if (!allowedSet.has(key)) throw new Error(`${label} has unknown field: ${key}`);
}

export function parseObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

export function parseRequiredString(input: unknown, label: string, allowEmpty = false): string {
  if (typeof input !== "string" || (!allowEmpty && !input.trim()) || /[\x00-\x1f\x7f]/.test(input)) throw new Error(`${label} is invalid`);
  return input;
}

export function parsePort(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > 65535) throw new Error(`${label} is invalid`);
  return input;
}
