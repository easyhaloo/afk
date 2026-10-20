/**
 * Canonical JSON: sorted keys, undefined values dropped.
 *
 * The rule for turning a value into the one string that stands for it.
 * Two values that differ only in the order of their keys — or only in
 * whether an absent field was written as `undefined` — have to produce
 * the same string, because the hashes computed over it are compared
 * across processes and across runs.
 *
 * It is used by the audit chain, which hashes every event onto the one
 * before it, and by the session store, which fingerprints a snapshot so a
 * changed file can be told from an intact one. Both need the same answer
 * to "what does this value look like as text", so it is written once here
 * rather than once per caller.
 *
 * The workflow graph package keeps a copy of its own: that package is
 * deliberately standalone, and its hash is only ever compared with itself.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => entry === undefined ? 'null' : stableJson(entry)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const entries: [string, unknown][] = Object.entries(value).filter(([, entry]) => entry !== undefined);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}
