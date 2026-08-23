import { describe, expect, it } from 'vitest';
import { graphSchemaVersion, type GraphSnapshot } from '../src';

describe('workflow graph IR', () => {
  it('exposes a versioned snapshot contract without runtime dependencies', () => {
    const snapshot: GraphSnapshot = {
      schemaVersion: graphSchemaVersion,
      kind: 'workflow',
      nodes: [],
      edges: [],
      tracks: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      diagnostics: [],
    };
    expect(snapshot.schemaVersion).toBe(1);
  });
});
