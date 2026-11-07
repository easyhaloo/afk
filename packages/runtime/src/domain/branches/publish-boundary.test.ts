import { describe, expect, it } from 'vitest';
import {
  decideMergeVerdict,
  describePublishBoundary,
  reservedBranches,
  type PublishBoundary,
} from './publish-boundary.js';

const boundary: PublishBoundary = {
  workingBranch: 'afk/backlog-9',
  targetBranch: 'prd/27',
  baseBranch: 'prd/27',
};

describe('reservedBranches', () => {
  it('names the branches the agent must not push to, without repeating itself', () => {
    expect(reservedBranches(boundary)).toEqual(['prd/27']);
  });

  it('keeps a distinct source branch apart from the baseline', () => {
    expect(reservedBranches({ ...boundary, baseBranch: '2025-11-8-show', sourceBranch: 'profession_nami_10.2' }))
      .toEqual(['prd/27', '2025-11-8-show', 'profession_nami_10.2']);
  });
});

describe('describePublishBoundary', () => {
  it('names the one branch the agent owns and the ones it does not', () => {
    const text = describePublishBoundary(boundary);
    expect(text).toContain('afk/backlog-9 is yours');
    expect(text).toContain('prd/27 belongs to AFK');
    expect(text).toContain('never push to it');
  });

  it('states the rule even when no branch has to be named', () => {
    const text = describePublishBoundary({ workingBranch: 'afk/backlog-9', targetBranch: '', baseBranch: '' });
    expect(text).toContain('afk/backlog-9 is yours');
    expect(text).toContain('commit and push only there');
    expect(text).toContain('AFK publishes the change request itself');
  });
});

describe('decideMergeVerdict', () => {
  it('sends a real conflict back for another round', () => {
    expect(decideMergeVerdict('conflict')).toBe('rework');
  });

  it('escalates a baseline that advanced instead of redoing the work', () => {
    expect(decideMergeVerdict('baseline_advanced')).toBe('escalate');
  });

  it('accepts a change request that can land', () => {
    expect(decideMergeVerdict('mergeable')).toBe('accept');
  });

  it('accepts a verdict the platform has not settled on', () => {
    expect(decideMergeVerdict('unknown')).toBe('accept');
    expect(decideMergeVerdict(undefined)).toBe('accept');
  });
});
