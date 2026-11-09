import { describe, expect, it } from 'vitest';
import { assertFactStatement, findActionInstruction, planReworkRevision } from './rework-revision.js';
import { reworkRecordId, type ReworkRecord } from './rework-record.js';

function record(overrides: Partial<ReworkRecord> = {}): ReworkRecord {
  return {
    version: 1,
    id: reworkRecordId(1, 2),
    cycle: 1,
    attempt: 2,
    status: 'open',
    source: 'qa',
    summary: 'The implementation is entirely absent from the QA worktree.',
    failedCriteria: [{ id: 'AC1', expected: 'the header is sent', actual: 'the test class is missing' }],
    requiredChecks: [{ command: 'mvn -Dtest=PapilotChatAdapterTest', expected: 'exit=0' }],
    createdAt: '2026-10-29T16:39:58.883Z',
    ...overrides,
  };
}

describe('a rework revision states a fact', () => {
  it('refuses the statement that read as a push to the PRD baseline', () => {
    expect(() => assertFactStatement('publish to prd/27')).toThrow(/must state a fact, not an instruction/);
  });

  it('refuses the instruction that made an agent push a branch it did not own', () => {
    expect(() => assertFactStatement('把 prd/27 合进当前分支并解决冲突')).toThrow(/must state a fact, not an instruction/);
  });

  it('refuses a directive to merge one branch into another', () => {
    expect(() => assertFactStatement('merge the target branch into the current branch')).toThrow(/must state a fact, not an instruction/);
  });

  it('refuses a statement that carries a git command', () => {
    expect(() => assertFactStatement('git push origin prd/27')).toThrow(/must state a fact, not an instruction/);
  });

  it('refuses a statement that carries a command that merges or re-runs work', () => {
    expect(() => assertFactStatement('run `afk backlog confirm-merge` to land it')).toThrow(/must state a fact, not an instruction/);
  });

  it('refuses an empty statement', () => {
    expect(() => assertFactStatement('   ')).toThrow(/must not be empty/);
  });

  it('accepts a statement that reports what is the case', () => {
    const statement = 'The dependency produced its change request; it is ready and awaits a person.';

    expect(findActionInstruction(statement)).toBeUndefined();
    expect(assertFactStatement(statement)).toBe(statement);
  });

  it('accepts a statement that names a merge request as a fact', () => {
    expect(findActionInstruction('变更请求 !161 无冲突、可合并，但尚未由人工合并（merged_at 为空）')).toBeUndefined();
  });

  it('accepts a statement that says what already happened', () => {
    expect(findActionInstruction('The change request was merged into the baseline by a person on 2026-11-05')).toBeUndefined();
  });
});

describe('planning a rework revision', () => {
  it('keeps the identity of the record and the evidence it carries', () => {
    const revised = planReworkRevision(record(), {
      summary: 'The dependency produced its change request; it is ready and awaits a person.',
      actor: 'shenggangshu@w.src.corp.qihoo.net',
      at: '2026-11-06T03:00:00.000Z',
    });

    expect(revised).toMatchObject({ id: 'r1-2', cycle: 1, attempt: 2, status: 'open', source: 'qa' });
    expect(revised.failedCriteria).toEqual(record().failedCriteria);
    expect(revised.requiredChecks).toEqual(record().requiredChecks);
    expect(revised.createdAt).toBe('2026-10-29T16:39:58.883Z');
  });

  it('replaces the statement and keeps the previous one in the record’s own trail', () => {
    const revised = planReworkRevision(record(), {
      summary: 'The dependency produced its change request; it is ready and awaits a person.',
      reason: 'the dependency’s merge request is ready but unmerged',
      actor: 'shenggangshu@w.src.corp.qihoo.net',
      at: '2026-11-06T03:00:00.000Z',
    });

    expect(revised.summary).toBe('The dependency produced its change request; it is ready and awaits a person.');
    expect(revised.revisions).toEqual([{
      at: '2026-11-06T03:00:00.000Z',
      actor: 'shenggangshu@w.src.corp.qihoo.net',
      from: 'The implementation is entirely absent from the QA worktree.',
      to: 'The dependency produced its change request; it is ready and awaits a person.',
      reason: 'the dependency’s merge request is ready but unmerged',
    }]);
  });

  it('keeps every earlier correction when the record is corrected again', () => {
    const first = planReworkRevision(record(), { summary: 'First correction.', actor: 'operator-a' });
    const second = planReworkRevision(first, { summary: 'Second correction.', actor: 'operator-b' });

    expect(second.revisions?.map(revision => revision.to)).toEqual(['First correction.', 'Second correction.']);
  });

  it('refuses a revision without an author', () => {
    expect(() => planReworkRevision(record(), { summary: 'A fact.', actor: '  ' }))
      .toThrow(/must name who wrote it/);
  });

  it('refuses a revision whose statement carries a directive', () => {
    expect(() => planReworkRevision(record(), { summary: 'publish to prd/27', actor: 'operator' }))
      .toThrow(/must state a fact, not an instruction/);
  });
});
