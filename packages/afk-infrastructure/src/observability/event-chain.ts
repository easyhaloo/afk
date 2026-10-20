/**
 * The event chain — one implementation of how a run's events are signed and
 * how a reader checks them.
 *
 * The rule was previously written twice: once in the JSONL store and once in
 * the desktop's read-only adapter. The two copies happened to agree, but they
 * were free to drift, and the digest is load-bearing: `lastSequence` is the
 * boundary a reader may trust, so a change to the signing rule would silently
 * change which events a reader believes.
 *
 * The chain is verified in order, and the boundary it reports is the last
 * event it vouches for. The `sequence_gap` check is what makes that boundary
 * safe: it guarantees the retained prefix is contiguous, so a re-sequenced or
 * spliced event cannot be smuggled into the verified region.
 */

import { createHash } from 'node:crypto';
import type { EventChainIntegrity, RunEvent, RunEventDraft } from '@afk/core';

/** Canonical JSON: sorted keys, undefined values dropped. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => entry === undefined ? 'null' : stableJson(entry)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const entries: [string, unknown][] = Object.entries(value).filter(([, entry]) => entry !== undefined);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

/** Sign one event, chaining it onto the previous one. */
export function signEvent(draft: RunEventDraft & { sequence: number; observedAt: string }, previous?: RunEvent): RunEvent {
  const integrity = { prevHash: previous?.integrity.hash };
  const hash = createHash('sha256').update(stableJson({ ...draft, integrity })).digest('hex');
  return { ...draft, integrity: { ...integrity, hash } } as RunEvent;
}

/** Does one event carry the hash its predecessor implies? */
function eventMatchesChain(event: RunEvent, previous?: RunEvent): boolean {
  if (previous?.integrity.hash !== event.integrity.prevHash) return false;
  const { integrity: _integrity, ...draft } = event;
  const expected = signEvent(draft as RunEventDraft & { sequence: number; observedAt: string }, previous);
  return expected.integrity.hash === event.integrity.hash;
}

/**
 * Verify a whole run's chain.
 *
 * On a broken chain the reported `lastSequence` is the sequence of the last
 * event that was verified, so the caller can keep exactly the prefix the
 * chain vouches for.
 */
export function verifyEventChain(runId: string, events: readonly RunEvent[]): EventChainIntegrity {
  let previous: RunEvent | undefined;
  let count = 0;
  for (const event of events) {
    count += 1;
    if (event.context.runId !== runId) {
      return { valid: false, lastSequence: count - 1, lastHash: previous?.integrity.hash, reason: 'run_id_mismatch' };
    }
    if (event.sequence !== count) {
      return { valid: false, lastSequence: count - 1, lastHash: previous?.integrity.hash, reason: 'sequence_gap' };
    }
    if (!eventMatchesChain(event, previous)) {
      return { valid: false, lastSequence: count - 1, lastHash: previous?.integrity.hash, reason: 'integrity_mismatch' };
    }
    previous = event;
  }
  return { valid: true, lastSequence: count, lastHash: previous?.integrity.hash };
}
