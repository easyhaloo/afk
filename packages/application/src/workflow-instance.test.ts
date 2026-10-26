import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventData } from '@afk/core';
import { projectWorkflowInstance } from './workflow-instance.js';

const event = (sequence: number, data: RunEventData): RunEvent => ({
  sequence, data, context: { runId: 'run-1', workItemId: 'work-1' }, occurredAt: '2026-10-15T00:00:00.000Z',
} as RunEvent);
const snapshot = event(1, { kind: 'workflow.recorded', name: 'recorded-template', version: 1, steps: [
  { id: 'implement', kind: 'agent', dependsOn: [], provider: 'opencode', executionMode: 'interactive' },
  { id: 'verify', kind: 'agent', dependsOn: ['implement'] },
] });

describe('workflow instance', () => {
  it('projects only recorded steps and outcomes without mutating the snapshot', () => {
    const result = projectWorkflowInstance('run-1', 'work-1', [snapshot,
      event(2, { kind: 'step.started', stepId: 'implement', phase: 'implementation' }),
      event(3, { kind: 'step.completed', stepId: 'implement', outcome: 'succeeded' }),
      event(4, { kind: 'step.started', stepId: 'verify', phase: 'verification' }),
      event(5, { kind: 'step.completed', stepId: 'verify', outcome: 'failed' }),
    ]);
    expect(result).toMatchObject({ name: 'recorded-template', steps: [{ id: 'implement', status: 'succeeded' }, { id: 'verify', status: 'failed', dependsOn: ['implement'] }] });
    expect(projectWorkflowInstance('run-1', 'work-1', [snapshot])?.steps[0].status).toBe('pending');
    expect(projectWorkflowInstance('run-1', 'work-1', [])).toBeUndefined();
  });
  it('rejects crossed identities and ambiguous snapshots', () => {
    expect(() => projectWorkflowInstance('other', 'work-1', [snapshot])).toThrow(/identity/);
    expect(() => projectWorkflowInstance('run-1', 'work-1', [snapshot, snapshot])).toThrow(/multiple/);
  });
});
