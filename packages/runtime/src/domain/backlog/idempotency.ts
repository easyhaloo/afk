import { createHash } from 'node:crypto';

/**
 * The retry marker of a backlog record.
 *
 * A repeated creation has to find the record it already made instead of
 * making a second one. The marker used to be a provider label, which put a
 * 64-character hash in front of every reader of the issue list; it is a
 * comment in the body instead, which a reader never sees.
 *
 * The body is the right place for it because the body is where the other
 * machine-owned fact of a record already lives — the execution base branch.
 */
const MARKER_PREFIX = 'afk:idempotency:';
const MARKER_PATTERN = /<!--\s*(afk:idempotency:[a-f0-9]{64})\s*-->/;

/** The marker that identifies the record a retry must find. */
export function idempotencyMarker(key: string): string {
  return `${MARKER_PREFIX}${createHash('sha256').update(key).digest('hex')}`;
}

/** The marker as a body carries it: a comment no reader sees. */
export function idempotencyMarkerComment(marker: string): string {
  return `<!-- ${marker} -->`;
}

/** The marker a body carries, when it carries one. */
export function idempotencyMarkerIn(description: string | undefined): string | undefined {
  const match = description?.match(MARKER_PATTERN);
  return match?.[1];
}

/** Put the marker into a body, leaving the rest of it where it was. */
export function withIdempotencyMarker(description: string, marker: string): string {
  return `${description.trimEnd()}\n\n${idempotencyMarkerComment(marker)}\n`;
}

/**
 * The label a record created before the marker moved into the body carries.
 *
 * A record that carries it is still found by a retry, so removing the label
 * from new records does not orphan the ones that already have it.
 */
export function legacyIdempotencyLabel(marker: string): string {
  return `idempotency::${marker.slice(MARKER_PREFIX.length)}`;
}
