import { describe, expect, it } from 'vitest';
import {
  compileTemplate,
  planSteps,
  selectAcVerificationStep,
  selectImplementationStep,
} from './compiler.js';
import type { WorkflowTemplate } from './types.js';

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

describe('compileTemplate — the compiled step carries the decisions', () => {
  it('resolves the phase and the completion kind of a step that declares neither', () => {
    const template: WorkflowTemplate = {
      name: 'legacy-shape',
      version: 1,
      steps: [
        { id: 'build', role: 'implementer', prompt: 'build' },
        { id: 'check', role: 'verifier', prompt: 'check', dependsOn: ['build'] },
      ],
    };
    const compiled = compileTemplate(template);
    expect(compiled.groups[0]?.steps[0]).toMatchObject({ phase: 'implementation', completionKind: 'task' });
    expect(compiled.groups[1]?.steps[0]).toMatchObject({ phase: 'verification', completionKind: 'ac' });
  });

  it('keeps the declared phase and completion kind', () => {
    const template: WorkflowTemplate = {
      name: 'declared',
      version: 1,
      steps: [{ id: 'check', role: 'implementer', phase: 'verification', completionKind: 'qa', prompt: 'check' }],
    };
    expect(compileTemplate(template).groups[0]?.steps[0]).toMatchObject({ phase: 'verification', completionKind: 'qa' });
  });

  it('keeps the signal type separate from the completion kind', () => {
    // The signal type is the marker every protocol shares; the completion
    // kind is the protocol. A template that declares 'goal_complete' still
    // means what it always meant.
    const template: WorkflowTemplate = {
      name: 'signal',
      version: 1,
      steps: [{ id: 'check', role: 'verifier', completion: 'goal_complete', prompt: 'check' }],
    };
    const step = compileTemplate(template).groups[0]?.steps[0];
    expect(step).toMatchObject({ completionSignal: 'goal_complete', completionKind: 'ac' });
  });

  it('gives a system step neither a phase nor a completion kind', () => {
    const template: WorkflowTemplate = {
      name: 'system-step',
      version: 1,
      steps: [{ id: 'publish', kind: 'system', action: 'publish-change', phase: 'implementation', completionKind: 'task' }],
    };
    const step = compileTemplate(template).groups[0]?.steps[0];
    expect(step).toMatchObject({ kind: 'system' });
    expect(step).not.toHaveProperty('phase');
    expect(step).not.toHaveProperty('completionKind');
  });
});

describe('selecting a step by what it declares', () => {
  const template: WorkflowTemplate = {
    name: 'renamed',
    version: 1,
    steps: [
      { id: 'build', role: 'implementer', phase: 'implementation', completionKind: 'task', prompt: 'build' },
      { id: 'check', role: 'verifier', phase: 'verification', completionKind: 'ac', prompt: 'check', dependsOn: ['build'] },
      { id: 'publish', kind: 'system', action: 'publish-change', dependsOn: ['check'] },
    ],
  };

  it('finds the acceptance-criteria step by its phase and its completion kind', () => {
    const steps = planSteps(compileTemplate(template));
    expect(selectAcVerificationStep(steps)).toMatchObject({ id: 'check', completionKind: 'ac' });
  });

  it('finds the implementation step by its phase', () => {
    const steps = planSteps(compileTemplate(template));
    expect(selectImplementationStep(steps)).toMatchObject({ id: 'build', phase: 'implementation' });
  });

  it('finds nothing in a plan that declares no acceptance-criteria step', () => {
    const steps = planSteps(compileTemplate({
      name: 'no-ac', version: 1,
      steps: [{ id: 'build', role: 'implementer', phase: 'implementation', completionKind: 'task', prompt: 'build' }],
    }));
    expect(selectAcVerificationStep(steps)).toBeUndefined();
    expect(selectImplementationStep(steps)).toMatchObject({ id: 'build' });
  });

  it('does not mistake a review step for the acceptance-criteria step', () => {
    const steps = planSteps(compileTemplate({
      name: 'review', version: 1,
      steps: [{ id: 'review', role: 'reviewer', phase: 'verification', completionKind: 'task', prompt: 'review' }],
    }));
    expect(selectAcVerificationStep(steps)).toBeUndefined();
  });
});
