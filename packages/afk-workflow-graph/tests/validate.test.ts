import { describe, expect, it } from 'vitest';
import { validateSnapshot } from '../src';

describe('validateSnapshot', () => {
  it('reports missing routes and endpoints', () => {
    const diagnostics = validateSnapshot({ schemaVersion: 1, kind: 'workflow', nodes: [], edges: [{ id: 'e', source: 'a', target: 'b', kind: 'dependency' }], tracks: [], bounds: { x: 0, y: 0, width: 1, height: 1 }, diagnostics: [] });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining(['invalid-snapshot', 'geometry/no-route']));
  });
});
