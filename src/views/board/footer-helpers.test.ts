import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock simple-git so we can deterministically test both code paths.
const mockBranchLocal = vi.fn();
vi.mock('simple-git', () => ({
  default: () => ({ branchLocal: mockBranchLocal }),
}));

import { formatPathLabel, getGitBranch, getShortPath } from './footer-helpers';

describe('formatPathLabel (AC1: ~/path (branch) format)', () => {
  it('combines path and branch into ~/path (branch) format', () => {
    expect(formatPathLabel('~/repo', 'feature-x')).toBe('~/repo (feature-x)');
  });

  it('keeps the main branch inside parens', () => {
    expect(formatPathLabel('~/work/proj', 'main')).toBe('~/work/proj (main)');
  });
});

describe('formatPathLabel (AC2: non-git directories only show pwd)', () => {
  it('returns the bare path when branch is null', () => {
    expect(formatPathLabel('~/somewhere', null)).toBe('~/somewhere');
  });

  it('returns the bare path when branch is an empty string', () => {
    // simpleGit can yield "" for detached HEAD — Footer must not render "()".
    expect(formatPathLabel('~/somewhere', '')).toBe('~/somewhere');
  });
});

describe('getGitBranch (AC2: returns null outside git repos)', () => {
  afterEach(() => {
    mockBranchLocal.mockReset();
  });

  it('returns the current branch when simple-git resolves', async () => {
    mockBranchLocal.mockResolvedValue({ current: 'feature-x' });
    expect(await getGitBranch()).toBe('feature-x');
  });

  it('returns null when simple-git throws (not in a git repo)', async () => {
    mockBranchLocal.mockRejectedValue(new Error('Not a git repository'));
    expect(await getGitBranch()).toBeNull();
  });

  it('returns null when current branch is empty (detached HEAD)', async () => {
    mockBranchLocal.mockResolvedValue({ current: '' });
    expect(await getGitBranch()).toBeNull();
  });
});
