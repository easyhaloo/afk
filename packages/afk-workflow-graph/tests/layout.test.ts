import { describe, expect, it } from 'vitest';
import { layoutWorkflow } from '../src';

describe('layoutWorkflow', () => {
  it('maps dependency depth to columns and emits one edge per dependency', () => {
    const snapshot = layoutWorkflow({ templateId: 'x', templateVersion: 1, name: 'X', steps: [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['a'] }] });
    expect(snapshot.nodes.find((node) => node.stepId === 'b')!.bounds.x).toBe(snapshot.nodes.find((node) => node.stepId === 'c')!.bounds.x);
    expect(snapshot.edges).toHaveLength(2);
    expect(snapshot.edges.every((edge) => edge.route)).toBe(true);
  });
});
