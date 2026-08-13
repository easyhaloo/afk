import { describe, expect, it } from 'vitest';
import { shouldReusePrimaryWorktree } from './worktree-selection';

describe('workflow step worktree selection', () => {
  it('reuses the primary worktree for the issue iid zero placeholder', () => {
    expect(shouldReusePrimaryWorktree({ type: 'issue', iid: 0 })).toBe(true);
  });

  it('creates a dedicated worktree for a real issue branch', () => {
    expect(shouldReusePrimaryWorktree({ type: 'issue', iid: 60 })).toBe(false);
  });
});
