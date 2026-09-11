import { describe, expect, it } from 'vitest';
import { routeBetween } from '../src';

describe('routeBetween', () => {
  it('returns orthogonal points with distinct horizontal and vertical segments', () => {
    const route = routeBetween({ id: 'a', stepId: 'a', label: 'a', kind: 'agent', trackId: 'track-default', bounds: { x: 0, y: 0, width: 100, height: 50 } }, { id: 'b', stepId: 'b', label: 'b', kind: 'agent', trackId: 'track-default', bounds: { x: 300, y: 100, width: 100, height: 50 } });
    expect(route?.points.length).toBe(4);
    expect(route?.segments.map((segment) => segment.kind)).toEqual(['horizontal', 'vertical', 'horizontal']);
  });
});
