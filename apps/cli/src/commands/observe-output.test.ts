import { initialRunAggregate, type RunEvent, type RunEventData } from '@afk/core';
import type { ObserveRunResult } from '@afk/application';
import { describe, expect, it } from 'vitest';
import { formatEvent, formatExecutionHistory, formatIntegrity, formatRun } from './observe-output.js';

function event(data: RunEventData, sequence = 1): RunEvent {
  return {
    id: `event-${sequence}`, schemaVersion: 1, type: data.kind, sequence,
    occurredAt: '2026-10-22T09:07:45.000Z', observedAt: '2026-10-22T09:07:45.000Z',
    context: { traceId: 'run-1', runId: 'run-1', workItemId: '229', profileId: 'local', attempt: 1, actor: { kind: 'system', id: 'test' } },
    correlationId: 'run-1', data, integrity: { hash: 'hash' },
  };
}

function observation(events: RunEvent[]): ObserveRunResult {
  return {
    runId: 'run-1', events,
    state: { ...initialRunAggregate(), sequence: events.length, run: { id: 'run-1', workItemId: '229', profileId: 'local', attempt: 1, status: 'running', phase: 'implementation' } },
    integrity: { valid: true, lastSequence: events.length },
  };
}

describe('observe text output', () => {
  it('keeps workspace context when tail hides its event and distinguishes recorded progress from status', () => {
    const observed = observation([
      event({ kind: 'workspace.prepared', workspace: '/worktrees/229', branch: 'afk/backlog-229', baseBranch: 'main' }),
      event({ kind: 'implementation.completed' }, 2),
    ]);
    const text = formatRun(observed, 1);
    expect(text).toContain('RUNNING');
    expect(text).toContain('/worktrees/229');
    expect(text).toContain('afk/backlog-229');
    expect(text).toContain('Implementation completed');
    expect(text).toContain('main');
    expect(text).toContain('Time zone');
    expect(text).toContain('Showing 1 of 2 events');
    expect(text).not.toContain('Workspace prepared');
    expect(text).not.toContain('ERROR');
    expect(text).not.toContain('\u001b[');
  });

  it('renders full multiline errors, QA criteria, tool failures and evidence without JSON', () => {
    const failure = formatEvent(event({ kind: 'failure.classified', failureClass: 'workflow_crash', summary: 'command failed\nsecond line with full details' }));
    expect(failure).toContain('ERROR');
    expect(failure).toContain('workflow_crash');
    expect(failure).toContain('second line with full details');
    expect(failure).not.toContain('"summary"');
    const qa = formatEvent(event({ kind: 'qa.failed', reason: 'blocked', summary: 'checks failed', failedCriteria: [{ id: 'test-1', expected: 'exit 0', actual: 'exit 1' }] }));
    expect(qa).toContain('Expected');
    expect(qa).toContain('exit 0');
    expect(qa).toContain('Actual');
    expect(qa).toContain('exit 1');
    const session = event({ kind: 'agent.session_recorded', sessionId: 'session-1', transcriptPath: '/logs/session.jsonl', tools: [{ id: 'tool-1', name: 'bash', result: 'failed', exitCode: 2 }] });
    session.evidence = [{ uri: '/logs/evidence.txt', sha256: 'hash', mediaType: 'text/plain', classification: 'internal', redactionStatus: 'applied' }];
    expect(formatEvent(session)).toContain('/logs/session.jsonl');
    expect(formatEvent(session)).toContain('Exit code');
    expect(formatEvent(session)).toContain('/logs/evidence.txt');
  });

  it('preserves newlines but removes terminal control sequences from event fields', () => {
    const text = formatEvent(event({ kind: 'failure.classified', failureClass: 'workflow_crash', summary: '\u001b[2Jerror\u001b[31m\nnext line' }));
    expect(text).toContain('error');
    expect(text).toContain('next line');
    expect(text).not.toContain('\u001b');
  });

  it.each([
    { kind: 'step.completed', stepId: 'step-1', outcome: 'failed' },
    { kind: 'effect.completed', effectKind: 'start_step', idempotencyKey: 'effect-1', outcome: 'failed' },
    { kind: 'run.finished', outcome: 'failed' },
    { kind: 'qa.failed' },
  ] satisfies RunEventData[])('explicitly identifies a failure with no recorded reason: $kind', data => {
    const text = formatEvent(event(data));
    expect(text).toContain('ERROR');
    expect(text).toContain('No detailed failure reason recorded');
  });

  it('shows human gates as waiting and cancellation as a warning', () => {
    expect(formatEvent(event({ kind: 'human_gate.opened', gateId: 'merge:1', reason: 'awaiting human merge' }))).toContain('WAIT');
    expect(formatEvent(event({ kind: 'run.finished', outcome: 'cancelled', reason: 'user request' }))).toContain('WARN');
    expect(formatEvent(event({ kind: 'decision.made', command: 'start', accepted: false, reason: 'run_not_pending' }))).toContain('WARN');
  });

  it('flags invalid integrity and excludes unverified event details and status', () => {
    const observed = observation([event({ kind: 'failure.classified', failureClass: 'tampered', summary: 'untrusted details' })]);
    observed.integrity = { valid: false, lastSequence: 0, reason: 'integrity_mismatch' };
    const text = formatRun(observed);
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('INVALID');
    expect(text).toContain('integrity_mismatch');
    expect(text).not.toContain('untrusted details');
    expect(text).not.toContain('RUNNING');
    expect(formatIntegrity(observed.integrity)).toContain('integrity_mismatch');
  });

  it('handles empty results and zero tail without inventing a run state', () => {
    const observed = observation([]);
    observed.state = initialRunAggregate();
    expect(formatRun(observed)).toContain('No events recorded');
    expect(formatRun(observation([event({ kind: 'run.started' })]), 0)).not.toContain('Run started\n');
    expect(formatExecutionHistory({ executions: [] })).toContain('No executions recorded');
  });

  it('preserves full run IDs and pagination instructions in execution lists', () => {
    const text = formatExecutionHistory({ executions: [{ runId: 'run-with-a-long-stable-id', workItemId: 'github:team/project#229', profileId: 'local', attempt: 2, status: 'running', phase: 'verification', sequence: 10, terminal: false }], nextCursor: 'run-with-a-long-stable-id' });
    expect(text).toContain('run-with-a-long-stable-id');
    expect(text).toContain('github:team/project#229');
    expect(text).toContain('RUNNING');
    expect(text).toContain('--since run-with-a-long-stable-id');
  });
});
