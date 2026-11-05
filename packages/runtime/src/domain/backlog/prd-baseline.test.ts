import { describe, expect, it, vi } from 'vitest';
import {
  applyPrdBaselineBranch,
  parsePrdBaselineBranch,
  prdBaselineBranch,
  prdBaselineBranchName,
  prdBaselineForParent,
  prdBaselinePlan,
  prdIssueNumber,
  resolveParentPrdBaseline,
  resolvePrdExecutionPlan,
} from './prd-baseline.js';
import { createExecutionPlan } from './execution-plan.js';

describe('PRD baseline branches', () => {
  it('names a PRD baseline branch after the PRD issue number', () => {
    expect(prdBaselineBranchName(27)).toBe('prd/27');
    expect(prdBaselineBranchName('10')).toBe('prd/10');
    expect(prdBaselineBranchName(27)).toBe(prdBaselineBranch({ issueNumber: 27 }));
    expect(() => prdBaselineBranchName('')).toThrow();
    expect(() => prdBaselineBranchName('main')).toThrow();
  });

  it('reads an explicitly declared baseline branch and ignores prose', () => {
    expect(parsePrdBaselineBranch('## Baseline Branch\n- Baseline Ref: feature/prd-27')).toBe('feature/prd-27');
    expect(parsePrdBaselineBranch('The prd/27 branch is discussed here')).toBeUndefined();
    expect(() => parsePrdBaselineBranch('## Baseline Branch\n- Baseline Ref: a\n- Baseline Ref: b')).toThrow();
    expect(() => parsePrdBaselineBranch('## Baseline Branch\n- Baseline Ref: a/../b')).toThrow();
    expect(prdBaselineBranch({ issueNumber: 27, description: '## Baseline Branch\n- Baseline Ref: feature/x' })).toBe('feature/x');
  });

  it('gives a slice the baseline of its PRD parent and nothing else', () => {
    expect(prdBaselineForParent({ kind: 'prd', issueNumber: 27 })).toBe('prd/27');
    expect(prdBaselineForParent({ kind: 'prd', issueNumber: 27, description: '## Baseline Branch\n- Baseline Ref: feature/x' })).toBe('feature/x');
    expect(prdBaselineForParent(undefined)).toBeUndefined();
    expect(prdBaselineForParent({ issueNumber: 27 })).toBeUndefined();
    expect(prdBaselineForParent({ kind: 'prd' })).toBeUndefined();
  });

  it('writes the baseline block once and keeps the rest of the body', () => {
    const updated = applyPrdBaselineBranch('## Context\ntext\n## Baseline Branch\n- Baseline Ref: old', 'prd/27');
    expect(updated.match(/## Baseline Branch/g)).toHaveLength(1);
    expect(parsePrdBaselineBranch(updated)).toBe('prd/27');
    expect(updated).toContain('## Context\ntext');
    const appended = applyPrdBaselineBranch('## Context\ntext', 'prd/27');
    expect(parsePrdBaselineBranch(appended)).toBe('prd/27');
    expect(appended).toContain('## Context\ntext');
  });

  it('leaves an execution base section alone when a baseline is written', () => {
    const body = '## Base Version\n- Base Ref: main\n- Source Ref: profession\n## Context\ntext';
    const updated = applyPrdBaselineBranch(body, 'prd/27');
    expect(updated).toContain('- Base Ref: main');
    expect(updated).toContain('- Source Ref: profession');
    expect(parsePrdBaselineBranch(updated)).toBe('prd/27');
  });

  it('names the branch after the issue number a parent ends with', () => {
    expect(prdIssueNumber('gitlab:host/group/project#27')).toBe(27);
    expect(prdIssueNumber('27')).toBe(27);
    expect(prdIssueNumber('github:org/repo')).toBeUndefined();
    expect(prdBaselineForParent({ kind: 'prd', id: 'gitlab:host/group/project#27' })).toBe('prd/27');
  });

  it('reads the PRD parent and refuses to guess when it cannot be read', async () => {
    const get = vi.fn(async () => ({ id: 'gitlab:host/group/project#27', issueNumber: 27, kind: 'prd' as const }));
    await expect(resolveParentPrdBaseline('gitlab:host/group/project#27', get)).resolves.toBe('prd/27');
    await expect(resolveParentPrdBaseline(undefined, get)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
    const failing = vi.fn(async () => { throw new Error('404 not found'); });
    await expect(resolveParentPrdBaseline('gitlab:host/group/project#27', failing))
      .rejects.toThrow(/cannot be read/);
    await expect(resolveParentPrdBaseline('gitlab:host/group/project#27', failing, { required: false }))
      .resolves.toBeUndefined();
  });

  it('builds the plan a slice of a PRD runs on', () => {
    expect(prdBaselinePlan('prd/27')).toEqual({ baseRef: 'prd/27', targetRef: 'prd/27' });
    expect(prdBaselinePlan('prd/27', 'profession_3.2'))
      .toEqual({ baseRef: 'prd/27', targetRef: 'prd/27', sourceRef: 'profession_3.2' });
  });

  it('lets a resolved plan win and the PRD baseline fill only the gap', () => {
    const fallback = createExecutionPlan({ baseRef: 'production', targetRef: 'production', sourceRef: 'profession_3.2' });
    const declared = createExecutionPlan({ baseRef: 'prd/27', targetRef: 'prd/27' });
    expect(resolvePrdExecutionPlan({ plan: declared, prdBaseline: 'prd/27', fallback })).toBe(declared);
    expect(resolvePrdExecutionPlan({ prdBaseline: 'prd/27', fallback }))
      .toEqual({ baseRef: 'prd/27', targetRef: 'prd/27', sourceRef: 'profession_3.2' });
    expect(resolvePrdExecutionPlan({ fallback })).toBe(fallback);
  });
});
