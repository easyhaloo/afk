import { describe, expect, it } from 'vitest';
import { WORKFLOW_STEP_KINDS, isWorkflowStepKind } from '../src/workflow-steps.js';

describe('the workflow step vocabulary', () => {
  it('names the kinds a workflow step can be', () => {
    expect([...WORKFLOW_STEP_KINDS]).toEqual(['agent', 'system']);
  });

  it('accepts every kind it names', () => {
    for (const kind of WORKFLOW_STEP_KINDS) {
      expect(isWorkflowStepKind(kind)).toBe(true);
    }
  });

  it('refuses anything else', () => {
    expect(isWorkflowStepKind('tool')).toBe(false);
    expect(isWorkflowStepKind('')).toBe(false);
    expect(isWorkflowStepKind(undefined)).toBe(false);
    expect(isWorkflowStepKind(null)).toBe(false);
    expect(isWorkflowStepKind(7)).toBe(false);
  });
});
