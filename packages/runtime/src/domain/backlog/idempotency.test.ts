import { describe, expect, it } from 'vitest';
import {
  idempotencyMarker,
  idempotencyMarkerComment,
  idempotencyMarkerIn,
  legacyIdempotencyLabel,
  withIdempotencyMarker,
} from './idempotency.js';

describe('backlog idempotency marker', () => {
  it('derives the same marker from the same key', () => {
    expect(idempotencyMarker('migration/anchor')).toBe(idempotencyMarker('migration/anchor'));
    expect(idempotencyMarker('migration/anchor')).toMatch(/^afk:idempotency:[a-f0-9]{64}$/);
  });

  it('derives a different marker from a different key', () => {
    expect(idempotencyMarker('migration/anchor')).not.toBe(idempotencyMarker('migration/other'));
  });

  it('reads the marker back out of a body', () => {
    const marker = idempotencyMarker('migration/anchor');
    const body = withIdempotencyMarker('## Context\n\nImplement it.', marker);

    expect(body).toContain('## Context');
    expect(body).toContain(idempotencyMarkerComment(marker));
    expect(idempotencyMarkerIn(body)).toBe(marker);
  });

  it('reports no marker for a body that carries none', () => {
    expect(idempotencyMarkerIn('## Context\n\nImplement it.')).toBeUndefined();
    expect(idempotencyMarkerIn(undefined)).toBeUndefined();
  });

  it('reads the label a record created before the marker moved into the body', () => {
    const marker = idempotencyMarker('migration/anchor');

    expect(legacyIdempotencyLabel(marker)).toBe(`idempotency::${marker.slice('afk:idempotency:'.length)}`);
  });
});
