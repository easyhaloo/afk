import { describe, expect, it } from 'vitest';
import { normalizeDefinition, type WorkflowGraphDefinition } from '../src';

const definitionWithSteps = (steps: WorkflowGraphDefinition['steps']): WorkflowGraphDefinition => ({
  templateId: 'test', templateVersion: 1, name: 'Test', steps,
});

describe('normalizeDefinition', () => {
  it('reports missing dependencies, duplicate ids, and cycles without creating undefined nodes', () => {
    const result = normalizeDefinition(definitionWithSteps([
      { id: 'a', dependsOn: ['missing'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: ['b'] },
    ]));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining(['missing-dependency', 'duplicate-id', 'cycle']));
    expect(result.steps.every((step) => Boolean(step.id))).toBe(true);
  });

  it('uses original order as the deterministic topological tie breaker', () => {
    const result = normalizeDefinition(definitionWithSteps([
      { id: 'b', dependsOn: [] }, { id: 'a', dependsOn: [] }, { id: 'c', dependsOn: ['a', 'b'] },
    ]));
    expect(result.order).toEqual(['b', 'a', 'c']);
  });
});
