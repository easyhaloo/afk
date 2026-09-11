import { describe, expect, it } from 'vitest';
import { projectWorkflow } from '../src';

describe('projectWorkflow', () => {
  it('projects authored workflow fields without inference', () => {
    const graph = projectWorkflow({
      templateId: 'review', templateVersion: 1, name: 'Review', description: 'Review flow',
      steps: [
        { id: 'implement', kind: 'agent', role: 'implementer', provider: 'codex', dependsOn: [] },
        { id: 'review', kind: 'agent', role: 'reviewer', when: { step: 'implement', equals: 'failed' }, dependsOn: ['implement'] },
      ],
    });
    expect(graph.steps[1]).toMatchObject({ id: 'review', dependsOn: ['implement'], when: { step: 'implement', equals: 'failed' } });
    expect(graph.steps[0].kind).toBe('agent');
    expect(graph.steps[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
