import { describe, expect, it } from 'vitest';
import { projectBacklogItem } from './projection.js';

const scope = { platform: 'gitlab', projectKey: 'gitlab.com/group/repo' } as const;

describe('backlog projection', () => {
  it('marks an issue that carries lifecycle and mode labels as managed', () => {
    const item = projectBacklogItem({
      issueNumber: 7,
      title: 'child issue',
      labels: ['stage::ready-for-issues', 'mode::afk'],
      state: 'opened',
    }, scope);

    expect(item.managed).toBe(true);
  });

  it('marks an issue without a mode label as unmanaged', () => {
    const item = projectBacklogItem({
      issueNumber: 8,
      title: 'manual issue',
      labels: ['stage::prd'],
      state: 'opened',
    }, scope);

    expect(item.managed).toBe(false);
  });

  it('marks an issue without any lifecycle label as unmanaged', () => {
    const item = projectBacklogItem({
      issueNumber: 9,
      title: 'plain issue',
      labels: ['business-tag'],
      state: 'opened',
    }, scope);

    expect(item.managed).toBe(false);
  });
});
