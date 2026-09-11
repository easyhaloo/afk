import { describe, expect, it } from 'vitest';
import { layoutWorkflow, toArchifyWorkflow } from '../src';

describe('toArchifyWorkflow', () => {
  it('exports authored nodes and dependencies with the showcase profile', () => {
    const definition = { templateId: 'review', templateVersion: 1, name: 'Review', steps: [
      { id: 'implement', dependsOn: [] },
      { id: 'review', dependsOn: ['implement'], when: { step: 'implement', equals: 'failed' } },
      { id: 'merge', dependsOn: ['review'] },
    ] } as const;
    const document = toArchifyWorkflow(layoutWorkflow(definition), definition);
    expect(document.meta.quality_profile).toBe('showcase');
    expect(document.nodes).toHaveLength(3);
    expect(document.edges).toHaveLength(2);
    expect(document.edges.find((edge) => edge.target === 'review')?.label).toBe('implement = failed');
    expect(document.nodes.every((node) => !('status' in node))).toBe(true);
  });
});
