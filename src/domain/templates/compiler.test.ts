import { describe, expect, it } from 'vitest';
import { compileTemplate } from './compiler';
import type { WorkflowTemplate } from './types';

describe('compileTemplate', () => {
  it('compiles every agent step to the unified completion signal', () => {
    const template: WorkflowTemplate = { name: 'legacy', version: 1, steps: [{ id: 'verify', role: 'verifier', prompt: 'verify' }] };
    const compiled = compileTemplate(template);
    expect(compiled.groups[0]?.steps[0]).toMatchObject({ kind: 'agent', completionSignal: 'goal_complete', legacy: true });
  });

  it('compiles typed agent and fixed system actions', () => {
    const template = { name: 'typed', version: 1, steps: [
      { id: 'implement', kind: 'agent', role: 'implementer', prompt: 'implement', completion: 'goal_complete' },
      { id: 'publish', kind: 'system', action: 'publish-change', dependsOn: ['implement'] },
    ] } as WorkflowTemplate;
    const compiled = compileTemplate(template);
    expect(compiled.groups.map(g => g.steps.map(s => s.kind))).toEqual([['agent'], ['system']]);
  });

  it('rejects unrecognized system actions during compilation', () => {
    const template = { name: 'bad', version: 1, steps: [{ id: 'bad-action', kind: 'system', action: 'shell' }] } as WorkflowTemplate;
    expect(() => compileTemplate(template)).toThrow(/unknown system action/);
  });

  it('allows a system action explicitly registered by the runtime', () => {
    const template = { name: 'plugin-action', version: 1, steps: [{ id: 'audit', kind: 'system', action: 'audit-report' }] } as WorkflowTemplate;
    expect(compileTemplate(template, { systemActions: ['audit-report'] }).groups[0]?.steps[0]).toMatchObject({ action: 'audit-report' });
  });
});
