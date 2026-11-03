import { describe, expect, it } from 'vitest';
import { closesIssue, closingReferences } from './closing-reference.js';

describe('closingReferences', () => {
  it('reads the issue a same-project reference closes', () => {
    expect(closingReferences('QA: PASS\nCloses #8')).toEqual([{ issueNumber: 8 }]);
  });

  it('reads the project a cross-repository reference names', () => {
    expect(closingReferences('QA: PASS\nCloses fang/services/k-base#3'))
      .toEqual([{ projectPath: 'fang/services/k-base', issueNumber: 3 }]);
  });

  it('reads every closing verb a platform understands', () => {
    const description = 'Fixes #1\nResolves #2\nCloses #3';
    expect(closingReferences(description).map(reference => reference.issueNumber)).toEqual([1, 2, 3]);
  });

  it('reads no reference from a description that only mentions issues', () => {
    expect(closingReferences('The change is verified against issue #8 and closes nothing')).toEqual([]);
  });

  it('reads nothing from an empty body', () => {
    expect(closingReferences(undefined)).toEqual([]);
    expect(closingReferences('')).toEqual([]);
  });
});

describe('closesIssue', () => {
  it('accepts a same-project reference', () => {
    expect(closesIssue('QA: PASS\nCloses #8', 8, 'fang/services/aiapi')).toBe(true);
  });

  it('accepts a cross-repository reference that names the project', () => {
    expect(closesIssue('Closes fang/services/k-base#3', 3, 'fang/services/k-base')).toBe(true);
  });

  it('rejects a reference to another issue', () => {
    expect(closesIssue('Closes #9', 8, 'fang/services/aiapi')).toBe(false);
  });

  it('rejects a reference to another repository', () => {
    expect(closesIssue('Closes fang/web/atlas#8', 8, 'fang/services/aiapi')).toBe(false);
  });

  it('rejects a body without any closing reference', () => {
    expect(closesIssue('QA: PASS\n## Verification Evidence', 8, 'fang/services/aiapi')).toBe(false);
  });
});
