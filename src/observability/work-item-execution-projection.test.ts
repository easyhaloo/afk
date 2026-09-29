import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventData } from '../core/events';
import { projectWorkItemExecution } from './work-item-execution-projection';

const workItemId = 'github:team/project#158';
function event(sequence: number, data: RunEventData, overrides: Partial<RunEvent<RunEventData>> = {}): RunEvent<RunEventData> {
  return {
    id: `event-${sequence}`, schemaVersion: 1, type: data.kind, sequence,
    occurredAt: `2026-09-29T00:00:0${sequence}.000Z`, observedAt: `2026-09-29T00:00:0${sequence}.000Z`,
    context: { traceId: 'trace', runId: 'implement-1', workItemId, profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'test' } },
    correlationId: 'execution-1', data, integrity: { hash: `hash-${sequence}` }, ...overrides,
  };
}
const requested = event(1, { kind: 'run.requested', run: { id: 'implement-1', workItemId, profileId: 'test', attempt: 1, status: 'pending' } });

describe('projectWorkItemExecution', () => {
  it('keeps implementation success in verifying, not QA PASS or done', () => {
    const result = projectWorkItemExecution({ runId: 'implement-1', events: [requested, event(2, { kind: 'run.started' }), event(3, { kind: 'run.finished', outcome: 'succeeded' })], integrity: { valid: true, lastSequence: 3 } });
    expect(result.summary).toMatchObject({ executionId: 'execution-1', runId: 'implement-1', workItemId, status: 'verifying', startedAt: requested.occurredAt });
    expect(result.timeline.events).toHaveLength(3);
  });

  it('keeps only verified events and marks a tampered stream unknown', () => {
    const result = projectWorkItemExecution({ runId: 'implement-1', events: [requested, event(2, { kind: 'run.started' }), event(3, { kind: 'run.finished', outcome: 'succeeded' })], integrity: { valid: false, lastSequence: 2, reason: 'integrity_mismatch' } });
    expect(result.summary).toMatchObject({ status: 'unknown', diagnostic: 'integrity_mismatch', updatedAt: '2026-09-29T00:00:02.000Z' });
    expect(result.timeline.events.map(item => item.sequence)).toEqual([1, 2]);
  });

  it('does not attach events from another repository or execution', () => {
    const foreign = event(2, { kind: 'run.started' }, { context: { ...requested.context, workItemId: 'github:other/project#158' } });
    const result = projectWorkItemExecution({ runId: 'implement-1', events: [requested, foreign], integrity: { valid: true, lastSequence: 2 } });
    expect(result.summary.status).toBe('unknown');
    expect(result.summary.diagnostic).toContain('identity');
  });

  it('rejects a signed stream whose run ID differs from the requested run ID', () => {
    const result = projectWorkItemExecution({ runId: 'other-run', events: [requested], integrity: { valid: true, lastSequence: 1 } });
    expect(result.summary).toMatchObject({ status: 'unknown', diagnostic: 'event_identity_mismatch' });
  });

  it('rejects a requested run whose payload claims another repository', () => {
    const mismatched = event(1, { kind: 'run.requested', run: { id: 'implement-1', workItemId: 'github:other/project#158', profileId: 'test', attempt: 1, status: 'pending' } });
    expect(projectWorkItemExecution({ runId: 'implement-1', events: [mismatched], integrity: { valid: true, lastSequence: 1 } }).summary)
      .toMatchObject({ status: 'unknown', diagnostic: 'event_identity_mismatch' });
  });

  it('uses runId as a backwards-compatible execution ID for legacy events', () => {
    const legacy = { ...requested, correlationId: 'implement-1' };
    expect(projectWorkItemExecution({ runId: 'implement-1', events: [legacy], integrity: { valid: true, lastSequence: 1 } }).summary)
      .toMatchObject({ executionId: 'implement-1', status: 'queued' });
  });

  it('does not treat a generic verification step as independent QA PASS', () => {
    const qaStarted = event(2, { kind: 'step.started', stepId: 'qa', phase: 'verification' });
    const failed = projectWorkItemExecution({ runId: 'implement-1', events: [requested, qaStarted, event(3, { kind: 'step.completed', stepId: 'qa', outcome: 'failed' })], integrity: { valid: true, lastSequence: 3 } });
    expect(failed.summary.status).toBe('rework');
    const passed = projectWorkItemExecution({ runId: 'implement-1', events: [requested, qaStarted, event(3, { kind: 'step.completed', stepId: 'qa', outcome: 'succeeded' }), event(4, { kind: 'change.created', changeId: 'pr-2', targetBranch: 'main', url: 'https://example.test/pr/2' })], integrity: { valid: true, lastSequence: 4 } });
    expect(passed.summary).toMatchObject({ status: 'publishing', pr: { id: 'pr-2', state: 'open', url: 'https://example.test/pr/2' } });
    const merged = projectWorkItemExecution({ runId: 'implement-1', events: [...passed.timeline.events, event(5, { kind: 'change.merge_verified', changeId: 'pr-2', targetBranch: 'main' })], integrity: { valid: true, lastSequence: 5 } });
    expect(merged.summary).toMatchObject({ status: 'unknown', diagnostic: 'qa_pass_not_audited', pr: { state: 'merged' } });
  });

  it('awaits merge only with explicit QA PASS and confirmed publication', () => {
    const events = [requested, event(2, { kind: 'qa.started' }), event(3, { kind: 'qa.passed' }),
      event(4, { kind: 'change.published', changeId: 'pr-2', url: 'https://example.test/pr/2' })];
    const beforePublication = projectWorkItemExecution({ runId: 'implement-1', events: events.slice(0, 3), integrity: { valid: true, lastSequence: 3 } });
    expect(beforePublication.summary.status).toBe('publishing');
    expect(projectWorkItemExecution({ runId: 'implement-1', events, integrity: { valid: true, lastSequence: 4 } }).summary)
      .toMatchObject({ status: 'awaiting_merge', pr: { id: 'pr-2', url: 'https://example.test/pr/2', state: 'open' } });
    expect(projectWorkItemExecution({ runId: 'implement-1', events: [requested, events[3]], integrity: { valid: true, lastSequence: 4 } }).summary.status).not.toBe('awaiting_merge');
  });

  it('routes explicit QA rework and preserves it after run.finished failed', () => {
    const events = [requested, event(2, { kind: 'qa.started' }), event(3, { kind: 'qa.failed', reason: 'rework' }), event(4, { kind: 'run.finished', outcome: 'failed' })];
    expect(projectWorkItemExecution({ runId: 'implement-1', events, integrity: { valid: true, lastSequence: 4 } }).summary.status).toBe('rework');
  });

  it('routes other QA failures to blocked, including after a terminal run failure', () => {
    const events = [requested, event(2, { kind: 'qa.failed', reason: 'tests failed' }), event(3, { kind: 'run.finished', outcome: 'failed' })];
    expect(projectWorkItemExecution({ runId: 'implement-1', events, integrity: { valid: true, lastSequence: 3 } }).summary.status).toBe('blocked');
  });

  it('marks done only for a verified child merge of the published PR after QA PASS', () => {
    const events = [requested, event(2, { kind: 'qa.passed' }), event(3, { kind: 'change.published', changeId: 'pr-2', url: 'https://example.test/pr/2' })];
    const child = event(4, { kind: 'change.merge_verified', changeId: 'pr-2', targetBranch: 'main', child: true });
    expect(projectWorkItemExecution({ runId: 'implement-1', events: [...events, child], integrity: { valid: true, lastSequence: 4 } }).summary)
      .toMatchObject({ status: 'done', pr: { state: 'merged' } });
    const root = event(4, { kind: 'change.merge_verified', changeId: 'pr-2', targetBranch: 'main' });
    expect(projectWorkItemExecution({ runId: 'implement-1', events: [...events, root], integrity: { valid: true, lastSequence: 4 } }).summary.status).not.toBe('done');
    const verifiedRoot = event(4, { kind: 'change.merge_verified', changeId: 'pr-2', targetBranch: 'main', child: false });
    expect(projectWorkItemExecution({ runId: 'implement-1', events: [...events, verifiedRoot, event(5, { kind: 'run.finished', outcome: 'succeeded' })], integrity: { valid: true, lastSequence: 5 } }).summary)
      .toMatchObject({ status: 'done', pr: { state: 'merged' } });
    expect(projectWorkItemExecution({ runId: 'implement-1', events: [...events, verifiedRoot, event(5, { kind: 'run.finished', outcome: 'failed' })], integrity: { valid: true, lastSequence: 5 } }).summary.status)
      .toBe('done');
  });

  it('reports missing streams as unknown rather than complete', () => {
    expect(projectWorkItemExecution({ runId: 'missing', events: [], integrity: { valid: true, lastSequence: 0 } }).summary)
      .toMatchObject({ runId: 'missing', status: 'unknown', diagnostic: 'missing_stream' });
  });
});
