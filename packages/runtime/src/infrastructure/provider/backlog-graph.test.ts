import { describe, expect, it, vi } from 'vitest';

const catalogs = vi.hoisted(() => ({
  listProjects: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('./tracker-provider-factory.js', () => ({
  createGlobalWorkItemCatalogs: vi.fn(() => [{ listProjects: catalogs.listProjects }]),
  createGitHubTracker: vi.fn(),
  createGitLabTracker: vi.fn(),
}));

import { createCrossProjectBacklogGraphSource } from './backlog-graph.js';
import type { TrackerProvider, TrackedIssue } from '../../domain/tracker/types.js';
import type { ProviderProjectRef } from '../../domain/work-item/types.js';

const HERE: ProviderProjectRef = { platform: 'gitlab', projectKey: 'group/project' };
const THERE: ProviderProjectRef = { platform: 'gitlab', projectKey: 'other/project' };

function issue(id: number, labels: string[]): TrackedIssue {
  return {
    id,
    platform: 'gitlab',
    title: `Issue ${id}`,
    description: '',
    labels,
    state: 'opened',
    url: `https://example.test/${id}`,
    projectId: 'group/project',
  };
}

function trackerOf(issues: TrackedIssue[]): TrackerProvider {
  return {
    platform: 'gitlab',
    projectId: 'group/project',
    listIssues: vi.fn(async (options: { labels?: string[] } = {}) => {
      const required = options.labels ?? [];
      return issues.filter(candidate => required.every(label => candidate.labels.includes(label)));
    }),
  } as unknown as TrackerProvider;
}

describe('cross-project backlog graph', () => {
  it('finds a child that carries the short, same-project relation label', async () => {
    catalogs.listProjects.mockResolvedValue([HERE]);
    const source = createCrossProjectBacklogGraphSource({
      trackerFor: async () => trackerOf([issue(42, ['parent::31'])]),
    });

    const children = await source.childrenOf('gitlab:group/project#31');

    expect(children.map(child => child.issueNumber)).toEqual([42]);
  });

  it('still finds a child that carries the canonical relation label', async () => {
    catalogs.listProjects.mockResolvedValue([HERE]);
    const source = createCrossProjectBacklogGraphSource({
      trackerFor: async () => trackerOf([issue(42, ['parent::gitlab:group/project#31'])]),
    });

    const children = await source.childrenOf('gitlab:group/project#31');

    expect(children.map(child => child.issueNumber)).toEqual([42]);
  });

  it('does not report another project\'s short-form label as a child of this one', async () => {
    catalogs.listProjects.mockResolvedValue([HERE, THERE]);
    const source = createCrossProjectBacklogGraphSource({
      trackerFor: async (project: ProviderProjectRef) => trackerOf(
        project.projectKey === HERE.projectKey
          ? [issue(42, ['parent::31'])]
          : [issue(7, ['parent::31'])],
      ),
    });

    const children = await source.childrenOf('gitlab:group/project#31');

    // The short form means "the issue with that number in the project the
    // label sits in", so the other project's issue 31 is not this one's child.
    expect(children.map(child => child.issueNumber)).toEqual([42]);
    expect(children.every(child => child.parentId === 'gitlab:group/project#31')).toBe(true);
  });

  it('finds a cross-project child that carries the canonical relation label', async () => {
    catalogs.listProjects.mockResolvedValue([THERE]);
    const source = createCrossProjectBacklogGraphSource({
      trackerFor: async () => trackerOf([issue(7, ['parent::gitlab:group/project#31'])]),
    });

    const children = await source.childrenOf('gitlab:group/project#31');

    expect(children.map(child => child.issueNumber)).toEqual([7]);
  });

  it('skips an issue whose relation metadata cannot be trusted, without hiding the others', async () => {
    catalogs.listProjects.mockResolvedValue([HERE]);
    const source = createCrossProjectBacklogGraphSource({
      trackerFor: async () => trackerOf([
        issue(42, ['parent::31', 'parent::gitlab:group/project#31']),
        issue(43, ['parent::31']),
      ]),
    });

    const children = await source.childrenOf('gitlab:group/project#31');

    // Two parent labels are malformed metadata; the issue is not a child
    // anybody may act on. The readable one beside it is still reported.
    expect(children.map(child => child.issueNumber)).toEqual([43]);
  });
});
