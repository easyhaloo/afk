import { describe, expect, it } from 'vitest';
import { toGlobalWorkItem } from './metadata.js';

const project = {
  platform: 'github' as const,
  projectKey: 'acme/api',
  providerProjectId: '101',
  name: 'api',
  defaultBranch: 'main',
  webUrl: 'https://github.com/acme/api',
};

describe('global work item metadata', () => {
  it('keeps existing PRD anchors visible and ineligible', () => {
    const item = toGlobalWorkItem(project, { issueNumber: 10, title: 'PRD', state: 'opened', labels: ['stage::prd'] });
    expect(item).toMatchObject({ state: 'prd', executionEligible: false, executionMode: 'hitl' });
  });
  it.each(['2026-10-15T08:00:00Z', undefined])('preserves the optional Provider updatedAt %s', updatedAt => {
    const item = toGlobalWorkItem(project, {
      issueNumber: 7, title: 'Timestamp', labels: [], state: 'opened', updatedAt,
    });
    expect(item.updatedAt).toBe(updatedAt);
  });

  it('keeps unmanaged issues visible but never execution eligible', () => {
    const item = toGlobalWorkItem(project, {
      issueNumber: 7,
      title: 'Ordinary issue',
      description: 'not managed by AFK',
      labels: ['customer', 'priority::high'],
      state: 'opened',
      webUrl: 'https://github.com/acme/api/issues/7',
    });

    expect(item).toMatchObject({
      id: 'github:acme/api#7',
      managed: false,
      executionEligible: false,
      state: 'blocked',
      executionMode: 'hitl',
      tags: ['customer', 'priority::high'],
    });
  });

  it('exposes business tags while hiding AFK workflow metadata', () => {
    const item = toGlobalWorkItem(project, {
      issueNumber: 8,
      title: 'Managed issue',
      description: '',
      labels: [
        'stage::ready-for-issues',
        'mode::afk',
        'parent::5',
        'depends-on::6',
        'team::api',
      ],
      state: 'opened',
      webUrl: 'https://github.com/acme/api/issues/8',
    });

    expect(item).toMatchObject({
      managed: true,
      executionEligible: true,
      state: 'ready',
      executionMode: 'afk',
      parentId: 'github:acme/api#5',
      dependsOn: ['github:acme/api#6'],
      tags: ['team::api'],
    });
  });

  it('keeps ready HITL issues executable for foreground agent runs', () => {
    const item = toGlobalWorkItem(project, {
      issueNumber: 9,
      title: 'Human guided issue',
      description: 'Implement this with a selected agent.',
      labels: ['stage::ready-for-issues', 'mode::hitl'],
      state: 'opened',
      webUrl: 'https://github.com/acme/api/issues/9',
    });

    expect(item).toMatchObject({ managed: true, executionEligible: true, state: 'ready', executionMode: 'hitl' });
  });
});
