import { describe, expect, it } from 'vitest';
import { getPlatformTag } from './kanban.js';

describe('kanban platform badges', () => {
  it('renders a distinct badge per tracker platform', () => {
    expect(getPlatformTag('github')).toContain('[GH]');
    expect(getPlatformTag('gitlab')).toContain('[GL]');
    expect(getPlatformTag('geelib')).toContain('[GE]');
  });

  it('keeps the legacy green GitLab badge as the fallback', () => {
    expect(getPlatformTag(undefined as never)).toContain('[GL]');
  });

  it('does not reuse the GitHub badge for geelib issues', () => {
    expect(getPlatformTag('geelib')).not.toBe(getPlatformTag('github'));
    expect(getPlatformTag('geelib')).not.toBe(getPlatformTag('gitlab'));
  });
});
