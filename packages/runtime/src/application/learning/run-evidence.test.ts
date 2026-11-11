import type { RunEvent, RunEventData } from '@afk/core';
import { describe, expect, it } from 'vitest';
import { experienceScope, successfulRunEvidenceFromEvents } from './run-evidence.js';

const scope = 'github:acme/wiki';
const input = { scope, runId: 'independent-qa', workItemId: `${scope}#42`, evidence: [] };
const history = (data: RunEventData[]): RunEvent[] => data.map((entry, index) => ({
  id: `event-${index}`, schemaVersion: 1, type: entry.kind, sequence: index + 1,
  occurredAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:00.000Z',
  context: { traceId: input.runId, runId: input.runId, workItemId: input.workItemId,
    profileId: 'fixture', attempt: 1, actor: { kind: 'system', id: 'runtime' } },
  correlationId: input.runId, data: entry, integrity: { hash: 'a'.repeat(64) },
}));
const successful = () => history([{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);

describe('shared QA event evidence', () => {
  it('derives project scope and requires a completed independent QA history', () => {
    expect(experienceScope(input.workItemId)).toBe(scope);
    expect(successfulRunEvidenceFromEvents(input, successful())).toMatchObject({
      evidence: ['run:independent-qa#qa.passed'], completionEvent: 'run.finished',
    });
    expect(() => successfulRunEvidenceFromEvents(input, history([{ kind: 'qa.passed' },
      { kind: 'run.finished', outcome: 'succeeded' }]))).toThrow(/successful independent QA/);
  });

  it('rejects other work items, analysis runs and a new unfinished QA cycle', () => {
    expect(() => successfulRunEvidenceFromEvents({ ...input, workItemId: `${scope}#43` }, successful())).toThrow(/another work item/);
    expect(() => successfulRunEvidenceFromEvents(input, successful().map(event => ({ ...event,
      context: { ...event.context, purpose: 'learning' } })))).toThrow(/Learning runs/);
    expect(() => successfulRunEvidenceFromEvents(input, history([{ kind: 'qa.started' }, { kind: 'qa.passed' },
      { kind: 'run.finished', outcome: 'succeeded' }, { kind: 'qa.started' }]))).toThrow(/successful independent QA/);
  });
});
