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
      labels: ['kind::prd'],
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

  it('reads a PRD anchor as a role with no lifecycle position', () => {
    const item = projectBacklogItem({
      issueNumber: 10,
      title: 'the PRD',
      labels: ['kind::prd', 'mode::hitl'],
      state: 'opened',
    }, scope);

    // The anchor is a container: it is managed and visible, but it has no
    // position in a lifecycle and it never runs.
    expect(item).toMatchObject({ managed: true, kind: 'prd', executionEligible: false, executionMode: 'hitl' });
    expect(item.state).toBeUndefined();
  });

  it('keeps a PRD anchor ineligible even when it carries an executable label', () => {
    // The role vetoes executability, not the state: an anchor that still
    // carries a stage label must not become runnable.
    const item = projectBacklogItem({
      issueNumber: 11,
      title: 'the PRD',
      labels: ['kind::prd', 'stage::ready-for-issues', 'mode::afk'],
      state: 'opened',
    }, scope);

    expect(item).toMatchObject({ kind: 'prd', executionEligible: false });
  });

  it('reads a closed PRD anchor as done', () => {
    const item = projectBacklogItem({
      issueNumber: 12,
      title: 'the closed PRD',
      labels: ['kind::prd', 'mode::hitl'],
      state: 'closed',
    }, scope);

    expect(item).toMatchObject({ kind: 'prd', state: 'done', executionEligible: false });
  });
});
