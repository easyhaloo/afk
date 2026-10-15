import type { RunEvent } from '@afk/core';

export type WorkflowInstanceStep = {
  id: string;
  kind: 'agent' | 'system';
  dependsOn: readonly string[];
  provider?: string;
  executionMode?: 'interactive' | 'batch';
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
};

export type WorkflowInstance = {
  name: string;
  version: 1;
  recordedAt: string;
  steps: WorkflowInstanceStep[];
};

export function projectWorkflowInstance(runId: string, workItemId: string, events: readonly RunEvent[]): WorkflowInstance | undefined {
  if (events.some(event => event.context.runId !== runId || event.context.workItemId !== workItemId)) throw new Error('workflow event identity mismatch');
  const recorded = events.filter(event => event.data.kind === 'workflow.recorded');
  if (!recorded.length) return undefined;
  if (recorded.length !== 1) throw new Error('multiple workflow snapshots for one run');
  const snapshot = recorded[0];
  if (snapshot.data.kind !== 'workflow.recorded') return undefined;
  const steps: WorkflowInstanceStep[] = snapshot.data.steps.map(step => ({ ...step, dependsOn: [...step.dependsOn], status: 'pending' }));
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('duplicate workflow step');
  for (const event of events) {
    if (event.sequence <= snapshot.sequence) continue;
    const data = event.data;
    if (data.kind !== 'step.started' && data.kind !== 'step.completed') continue;
    const step = steps.find(candidate => candidate.id === data.stepId);
    if (step) step.status = data.kind === 'step.started' ? 'running' : data.outcome;
  }
  return { name: snapshot.data.name, version: snapshot.data.version, recordedAt: snapshot.occurredAt, steps };
}
