import { describe, expect, it } from 'vitest';
import {
  compareReworkRecords,
  latestOpenRework,
  nextReworkAttempt,
  parseReworkRecord,
  renderReworkRecord,
  reworkRecordId,
  type ReworkRecord,
  type ReworkStatus,
} from './rework-record.js';

function record(overrides: Partial<ReworkRecord> & { cycle: number; attempt: number }): ReworkRecord {
  return {
    version: 1,
    id: reworkRecordId(overrides.cycle, overrides.attempt),
    status: 'open' as ReworkStatus,
    source: 'qa',
    summary: 'QA failure',
    failedCriteria: [],
    requiredChecks: [],
    createdAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('rework cycles', () => {
  it('spends the first attempt of the first cycle on the first QA failure', () => {
    expect(nextReworkAttempt([], 'qa')).toEqual({ cycle: 1, attempt: 1 });
  });

  it('opens the first cycle without spending an attempt when the operator retries first', () => {
    expect(nextReworkAttempt([], 'operator')).toEqual({ cycle: 1, attempt: 0 });
  });

  it('keeps spending the budget of the running cycle while QA fails again', () => {
    const history = [record({ cycle: 1, attempt: 1 })];

    expect(nextReworkAttempt(history, 'qa')).toEqual({ cycle: 1, attempt: 2 });
    expect(nextReworkAttempt([...history, record({ cycle: 1, attempt: 2 })], 'qa')).toEqual({ cycle: 1, attempt: 3 });
  });

  it('opens a new cycle with a full budget when an operator retries', () => {
    const history = [
      record({ cycle: 1, attempt: 1 }),
      record({ cycle: 1, attempt: 2 }),
      record({ cycle: 1, attempt: 3 }),
    ];

    expect(nextReworkAttempt(history, 'operator')).toEqual({ cycle: 2, attempt: 0 });
  });

  it('counts the first QA failure of a new cycle as attempt 1, not as a continuation', () => {
    const history = [record({ cycle: 1, attempt: 3 }), record({ cycle: 2, attempt: 0, source: 'operator' })];

    expect(nextReworkAttempt(history, 'qa')).toEqual({ cycle: 2, attempt: 1 });
  });

  it('does not let a closed record of an earlier cycle spend the budget of the current one', () => {
    const history = [
      record({ cycle: 1, attempt: 3, status: 'resolved' }),
      record({ cycle: 2, attempt: 0, source: 'operator' }),
    ];

    expect(nextReworkAttempt(history, 'qa')).toEqual({ cycle: 2, attempt: 1 });
  });

  it('spends an attempt of the running cycle on a merge conflict', () => {
    const history = [record({ cycle: 1, attempt: 1 })];

    expect(nextReworkAttempt(history, 'conflict')).toEqual({ cycle: 1, attempt: 2 });
  });

  it('names a record after the cycle and the attempt it carries', () => {
    expect(reworkRecordId(1, 0)).toBe('r1-0');
    expect(reworkRecordId(2, 3)).toBe('r2-3');
  });
});

describe('rework record codec', () => {
  it('reads the cycle and the attempt back from the record', () => {
    const parsed = parseReworkRecord({ id: 'comment-1', body: renderReworkRecord(record({ cycle: 2, attempt: 1 })) });

    expect(parsed?.record).toMatchObject({ id: 'r2-1', cycle: 2, attempt: 1 });
  });

  it('reads a record written before cycles existed as the first cycle', () => {
    const legacy = [
      '<!-- afk:rework:v1 id=r3 -->',
      '',
      '## AFK Rework r3 · open',
      '',
      'QA failure',
      '',
      '```json',
      JSON.stringify({
        version: 1, id: 'r3', attempt: 3, status: 'open', source: 'qa', summary: 'QA failure',
        failedCriteria: [], requiredChecks: [], createdAt: '2026-10-01T00:00:00.000Z',
      }),
      '```',
    ].join('\n');

    expect(parseReworkRecord({ id: 'comment-1', body: legacy })?.record).toMatchObject({ id: 'r3', cycle: 1, attempt: 3 });
  });

  it('rejects a record whose id does not match its marker', () => {
    const body = renderReworkRecord(record({ cycle: 1, attempt: 1 })).replace('id=r1-1', 'id=r9-9');

    expect(parseReworkRecord({ id: 'comment-1', body })).toBeUndefined();
  });

  it('rejects a record with a malformed cycle', () => {
    const body = renderReworkRecord(record({ cycle: 1, attempt: 1 })).replace('"cycle":1', '"cycle":0');

    expect(parseReworkRecord({ id: 'comment-1', body })).toBeUndefined();
  });

  it('orders records by cycle first and by attempt second', () => {
    const older = record({ cycle: 1, attempt: 9 });
    const newer = record({ cycle: 2, attempt: 0 });

    expect(compareReworkRecords(newer, older)).toBeGreaterThan(0);
    expect(compareReworkRecords(record({ cycle: 1, attempt: 2 }), record({ cycle: 1, attempt: 1 }))).toBeGreaterThan(0);
  });

  it('finds the open record of the newest cycle', () => {
    const comments = [
      { id: 'comment-1', body: renderReworkRecord(record({ cycle: 1, attempt: 1, status: 'resolved' })) },
      { id: 'comment-2', body: renderReworkRecord(record({ cycle: 2, attempt: 0, source: 'operator' })) },
    ];

    expect(latestOpenRework(comments)?.record).toMatchObject({ id: 'r2-0', cycle: 2, source: 'operator' });
  });

  it('reads the revision trail of a corrected record back', () => {
    const corrected = record({
      cycle: 1,
      attempt: 2,
      summary: 'The dependency produced its change request; it is ready and awaits a person.',
      revisions: [{
        at: '2026-11-06T03:00:00.000Z',
        actor: 'shenggangshu@w.src.corp.qihoo.net',
        from: 'QA failure',
        to: 'The dependency produced its change request; it is ready and awaits a person.',
        reason: 'the dependency’s merge request is ready but unmerged',
      }],
    });

    const parsed = parseReworkRecord({ id: 'comment-1', body: renderReworkRecord(corrected) });

    expect(parsed?.record.revisions).toEqual([corrected.revisions![0]]);
    expect(parsed?.record.summary).toBe('The dependency produced its change request; it is ready and awaits a person.');
  });

  it('shows the revision trail to a reader of the issue', () => {
    const body = renderReworkRecord(record({
      cycle: 1,
      attempt: 2,
      revisions: [{
        at: '2026-11-06T03:00:00.000Z',
        actor: 'shenggangshu@w.src.corp.qihoo.net',
        from: 'QA failure',
        to: 'The dependency produced its change request.',
      }],
    }));

    expect(body).toContain('### Revisions');
    expect(body).toContain('2026-11-06T03:00:00.000Z by shenggangshu@w.src.corp.qihoo.net: QA failure → The dependency produced its change request.');
  });

  it('rejects a record whose revision trail is malformed', () => {
    const body = renderReworkRecord(record({ cycle: 1, attempt: 2 }))
      .replace('"createdAt"', '"revisions":[{"at":"2026-11-06T03:00:00.000Z"}],"createdAt"');

    expect(parseReworkRecord({ id: 'comment-1', body })).toBeUndefined();
  });
});
