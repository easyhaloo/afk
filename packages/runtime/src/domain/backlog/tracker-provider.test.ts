import { describe, expect, it, vi } from 'vitest';
import { TrackerBacklogProvider } from './tracker-provider.js';
import { GitHubBacklogProvider } from './github-provider.js';
import { GitLabBacklogProvider } from './gitlab-provider.js';
import { ManagementBacklogProvider } from './management-provider.js';
import { adoptBacklog } from './commands.js';
import type { ClaimLease } from './claim.js';
import type { TrackerProvider } from '../tracker/types.js';
import type { BacklogProvider } from './index.js';

function tracker(issue: any): TrackerProvider {
  return {
    platform: 'github', projectId: 'org/repo',
    getIssue: vi.fn(async () => ({ ...issue })),
    listIssues: vi.fn(async () => [{ ...issue }]),
    updateIssue: vi.fn(async (_id, updates) => {
      issue.labels = updates.labels ?? issue.labels;
      if (updates.state === 'closed') issue.state = 'closed';
    }),
    updateLabels: vi.fn(async (_id, delta) => {
      issue.labels = [
        ...issue.labels.filter((label: string) => !delta.remove.includes(label)),
        ...delta.add.filter((label: string) => !issue.labels.includes(label)),
      ];
    }),
    listMRs: vi.fn(async () => []),
    getMR: vi.fn(),
  } as unknown as TrackerProvider;
}

describe('TrackerBacklogProvider', () => {
  it('plans the same creation through every provider wrapper', async () => {
    const t = tracker({ id: 7, platform: 'github', projectId: 'org/repo', labels: [], state: 'opened' });
    const expected = ['stage::ready-for-issues', 'mode::afk', 'parent::github:org/repo#7'];
    const plan = async (provider: BacklogProvider) =>
      (await provider.planCreate({ title: 'Child', description: 'Body', parentId: '7' })).labels;

    // The dry run and the real creation must produce the same plan, so every
    // wrapper has to carry the planning behaviour of the provider it wraps.
    expect(await plan(new TrackerBacklogProvider(t))).toEqual(expected);
    expect(await plan(new GitHubBacklogProvider(t))).toEqual(expected);
    expect(await plan(new ManagementBacklogProvider(new GitHubBacklogProvider(t)))).toEqual(expected);
  });

  it('recognizes PRD anchors without allowing claims or adoption', async () => {
    const t = tracker({ id: 10, platform: 'github', projectId: 'org/repo', labels: ['stage::prd'], state: 'opened' });
    const provider = new TrackerBacklogProvider(t);
    const anchor = await provider.get('10');
    expect(anchor).toMatchObject({ state: 'prd', executionEligible: false, executionMode: 'hitl' });
    await expect(provider.isRunnable(anchor)).resolves.toBe(false);
    await expect(provider.adopt('10')).rejects.toThrow('invalid adoption metadata');
  });

  it('resolves qualified relationships in their own repository even when IIDs collide', async () => {
    const remote = { ...tracker({ id: 7, platform: 'github', projectId: 'org/other', title: 'Remote', labels: ['stage::done'], state: 'closed' }), projectId: 'org/other' };
    const issue = { id: 42, platform: 'github', projectId: 'org/repo', title: 'Child', labels: [] as string[], state: 'opened' };
    const t = { ...tracker(issue), forProject: vi.fn(() => remote),
      createIssue: vi.fn(async (input: any) => { issue.labels = input.labels; return 42; }), linkIssues: vi.fn(async () => {}) };
    const provider = new TrackerBacklogProvider(t);
    const created = await provider.create({ title: 'Child', description: 'Body', parentId: 'github:org/other#7', dependsOn: ['github:org/other#7'] });
    expect(created).toMatchObject({ parentId: 'github:org/other#7', dependsOn: ['github:org/other#7'] });
    expect(t.forProject).toHaveBeenCalledWith('org/other');
    expect(remote.getIssue).toHaveBeenCalledWith(7);
    expect(t.linkIssues).toHaveBeenCalledWith(42, 7, 'blocked_by', 'org/other');
    await expect(provider.isRunnable(created)).resolves.toBe(true);
  });

  it('returns an existing issue for a repeated idempotency key', async () => {
    const issue = { id: 42, platform: 'github', projectId: 'org/repo', title: 'Anchor', labels: [] as string[], state: 'opened' };
    const t = { ...tracker(issue), ensureBacklogMetadata: vi.fn(async () => {}),
      listIssues: vi.fn(async () => issue.labels.length ? [{ ...issue }] : []),
      createIssue: vi.fn(async (input: any) => { issue.labels = input.labels; return 42; }) };
    const provider = new TrackerBacklogProvider(t);
    const input = { title: 'Anchor', description: 'Body', stage: 'prd' as const, idempotencyKey: 'migration/anchor' };
    expect((await provider.create(input)).id).toBe('github:org/repo#42');
    expect((await provider.create(input)).id).toBe('github:org/repo#42');
    expect(t.createIssue).toHaveBeenCalledTimes(1);
    expect((await provider.get('42')).tags).toEqual([]);
  });

  it.each([
    ['stage::ready-for-issues'], ['mode::afk'], ['stage::ready-for-issues', 'mode::afk'],
  ])('fills only missing adoption labels and remains idempotent: %j', async (...labels) => {
    const issue = { id: 42, labels: [...labels, 'feature'], state: 'opened', projectId: 'org/repo' };
    const t = { ...tracker(issue), ensureBacklogMetadata: vi.fn(async () => {}) };
    const provider = new TrackerBacklogProvider(t);
    const missing = ['stage::ready-for-issues', 'mode::afk'].filter(label => !labels.includes(label));

    await provider.adopt('42');
    await provider.adopt('42');

    expect(issue.labels).toEqual([...labels, 'feature', ...missing]);
    expect(t.updateLabels).toHaveBeenCalledTimes(missing.length ? 1 : 0);
    expect(t.ensureBacklogMetadata).toHaveBeenCalledTimes(missing.length ? 1 : 0);
    if (missing.length) expect(t.updateLabels).toHaveBeenCalledWith(42, { add: missing, remove: [] });
    expect(t.updateIssue).not.toHaveBeenCalled();
  });

  it.each([
    ['stage::blocked'], ['mode::hitl'], ['stage::rework'], ['stage::afk-in-progress'],
    ['stage::qa'], ['stage::merge-ready'], ['stage::done'], ['stage::unknown'], ['mode::unknown'],
    ['stage::ready-for-issues', 'stage::ready-for-issues'], ['mode::afk', 'mode::afk'],
    ['stage::ready-for-issues', 'stage::blocked'], ['mode::afk', 'mode::hitl'],
    ['parent::7', 'parent::8'], ['base::6', 'base::7'], ['parent::7', 'parent::7'],
    ['depends-on::5', 'depends_on::5'],
    ['parent::42'], ['base::42'], ['depends-on::42'], ['depends_on::42'],
    ['parent::'], ['base::'], ['parent::0'], ['base::-1'], ['parent::1.5'],
    ['base::abc'], ['parent::7::8'], ['base:: 7'], ['parent::07'], ['base::1e2'],
    ['depends-on::abc'], ['depends_on::'],
    ['parent::9007199254740992'],
  ])('rejects unsafe adoption metadata without writing: %j', async (...labels) => {
    const issue = { id: 42, labels, state: 'opened', projectId: 'org/repo' };
    const t = { ...tracker(issue), ensureBacklogMetadata: vi.fn(async () => {}) };

    await expect(new TrackerBacklogProvider(t).adopt('42')).rejects.toThrow(/invalid adoption metadata|tracker backlog id must be a positive integer/);

    expect(t.ensureBacklogMetadata).not.toHaveBeenCalled();
    expect(t.updateLabels).not.toHaveBeenCalled();
    expect(t.updateIssue).not.toHaveBeenCalled();
    expect(issue.labels).toEqual(labels);
  });

  it.each(['closed', 'merged'])('rejects a %s issue even with canonical adoption labels', async state => {
    const t = { ...tracker({ id: 42, labels: ['stage::ready-for-issues', 'mode::afk'], state }),
      ensureBacklogMetadata: vi.fn(async () => {}) };

    await expect(new TrackerBacklogProvider(t).adopt('42')).rejects.toThrow('must be open');
    expect(t.ensureBacklogMetadata).not.toHaveBeenCalled();
    expect(t.updateLabels).not.toHaveBeenCalled();
    expect(t.updateIssue).not.toHaveBeenCalled();
  });

  it('does not add adoption labels when metadata initialization fails', async () => {
    const t = { ...tracker({ id: 42, labels: [], state: 'opened' }),
      ensureBacklogMetadata: vi.fn().mockRejectedValue(new Error('metadata unavailable')) };

    await expect(new TrackerBacklogProvider(t).adopt('42')).rejects.toThrow('metadata unavailable');
    expect(t.updateLabels).not.toHaveBeenCalled();
  });

  it.each(['github', 'gitlab'] as const)('explicitly adopts an open manual %s issue through the management facade', async platform => {
    const issue = {
      id: 42, platform, title: 'Manual issue', description: 'Keep this body',
      labels: ['feature', 'team::api', 'parent::7', 'base::6', 'depends-on::5'],
      state: 'opened', url: 'https://example/42', projectId: 'org/repo',
    };
    const t = { ...tracker(issue), platform, ensureBacklogMetadata: vi.fn(async () => {}) };
    const provider = new ManagementBacklogProvider(platform === 'github'
      ? new GitHubBacklogProvider(t)
      : new GitLabBacklogProvider(t));

    await expect(adoptBacklog(provider, '42')).resolves.toMatchObject({
      id: `${platform}:org/repo#42`, title: issue.title, description: issue.description,
      state: 'ready', executionMode: 'afk', tags: ['feature', 'team::api'],
      parentId: `${platform}:org/repo#7`, baseBacklogId: `${platform}:org/repo#6`, dependsOn: [`${platform}:org/repo#5`],
    });
    expect(t.updateLabels).toHaveBeenCalledWith(42, {
      add: ['stage::ready-for-issues', 'mode::afk'], remove: [],
    });
    expect(t.ensureBacklogMetadata.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(t.updateLabels).mock.invocationCallOrder[0]);
    expect(t.updateIssue).not.toHaveBeenCalled();
    expect('claim' in provider).toBe(false);
  });

  it('projects the durable QA change metadata for a merge-ready backlog', async () => {
    const issue = {
      id: 42,
      title: 'Ready for merge',
      description: 'body',
      labels: ['stage::merge-ready', 'mode::hitl'],
      state: 'opened',
      url: 'https://example/42',
      projectId: 'org/repo',
    };
    const t = tracker(issue);
    t.listMRs = vi.fn(async () => [{
      id: 9,
      platform: 'github',
      projectId: 'org/repo',
      title: 'Backlog 42: Ready for merge',
      state: 'opened',
      sourceBranch: 'afk/backlog-42-qa',
      targetBranch: 'main',
      url: 'https://example/pull/9',
    }]);
    t.getMR = vi.fn(async () => ({
      id: 9,
      platform: 'github',
      projectId: 'org/repo',
      title: 'Backlog 42: Ready for merge',
      state: 'opened',
      sourceBranch: 'afk/backlog-42-qa',
      targetBranch: 'main',
      url: 'https://example/pull/9',
    }));
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await expect(provider.get('42')).resolves.toMatchObject({
      changeRequest: {
        id: '9',
        state: 'open',
        url: 'https://example/pull/9',
      },
    });
  });

  it('creates a child backlog with metadata, provider links, and concrete URLs in its body', async () => {
    const parent = { id: 7, title: 'PRD', description: '', labels: [], state: 'opened', url: 'https://example/7', projectId: 'org/repo' };
    const dependency = { id: 6, title: 'Foundation', description: '', labels: [], state: 'opened', url: 'https://example/6', projectId: 'org/repo' };
    const created = { id: 42, title: 'Child', description: '', labels: [], state: 'opened', url: 'https://example/42', projectId: 'org/repo' };
    const t = tracker(created);
    t.getIssue = vi.fn(async id => ({ [6]: dependency, [7]: parent, [42]: created }[id]!));
    t.createIssue = vi.fn(async input => {
      created.title = input.title;
      created.description = input.description ?? '';
      created.labels = input.labels ?? [];
      return 42;
    });
    t.updateIssue = vi.fn(async (_id, updates) => { created.description = updates.description ?? created.description; });
    t.linkIssues = vi.fn(async () => {});
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await expect(provider.create({
      title: 'Child', description: '## Context\n\nImplement the capability.', parentId: '7', dependsOn: ['6'], tags: ['feature'],
    })).resolves.toMatchObject({ id: 'github:org/repo#42', parentId: 'github:org/repo#7', dependsOn: ['github:org/repo#6'], webUrl: 'https://example/42' });

    expect(t.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      labels: ['stage::ready-for-issues', 'mode::afk', 'feature', 'parent::github:org/repo#7', 'depends-on::github:org/repo#6'],
      description: expect.stringContaining('[#7](https://example/7)'),
    }));
    expect(t.linkIssues).toHaveBeenCalledWith(42, 6, 'blocked_by');
    expect(t.updateIssue).toHaveBeenCalledWith(42, expect.objectContaining({
      description: expect.stringContaining('[#42](https://example/42)'),
    }));
    expect(created.description).toContain('[#6](https://example/6)');
  });

  it('provisions tracker-native metadata before creating a backlog', async () => {
    const created = { id: 42, title: 'Item', description: '', labels: [], state: 'opened', url: 'https://example/42', projectId: 'org/repo' };
    const t = tracker(created);
    const ensureBacklogMetadata = vi.fn(async () => {});
    t.ensureBacklogMetadata = ensureBacklogMetadata;
    t.createIssue = vi.fn(async input => {
      created.title = input.title;
      created.description = input.description ?? '';
      created.labels = input.labels ?? [];
      return 42;
    });
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await provider.create({ title: 'Item', description: '## Acceptance Criteria\n- [ ] works -- test -- true' });

    expect(ensureBacklogMetadata).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'stage::ready-for-issues' }),
      expect.objectContaining({ name: 'mode::afk' }),
    ]));
    expect(ensureBacklogMetadata.mock.invocationCallOrder[0])
      .toBeLessThan((t.createIssue as any).mock.invocationCallOrder[0]);
  });

  it('maps labels and relationship metadata to canonical backlog fields', async () => {
    const issue = {
      id: 42, title: 'Child', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'parent::10', 'base::8', 'depends-on::9'],
      state: 'opened', url: 'https://example/42', projectId: 'org/repo',
    };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn() });
    await expect(provider.get('42')).resolves.toMatchObject({
      id: 'github:org/repo#42', parentId: 'github:org/repo#10', baseBacklogId: 'github:org/repo#8',
      dependsOn: ['github:org/repo#9'], state: 'ready', executionMode: 'afk', branchName: 'afk/backlog-42',
      webUrl: 'https://example/42',
    });
  });

  it('transitions canonical state by replacing only workflow labels', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'team::api'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });
    await provider.transition('42', 'blocked', { reason: 'timeout' });
    expect(t.updateLabels).toHaveBeenCalledWith(42, {
      add: ['stage::blocked', 'mode::hitl'],
      remove: ['stage::ready-for-issues', 'mode::afk'],
    });
    expect(t.updateIssue).not.toHaveBeenCalled();
  });

  it('preserves the execution mode when transitioning a non-blocked state', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'team::api'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await provider.transition('42', 'verification');

    expect(t.updateLabels).toHaveBeenCalledWith(42, {
      add: ['stage::qa'],
      remove: ['stage::ready-for-issues'],
    });
    expect(t.updateIssue).not.toHaveBeenCalled();
    expect(issue.state).toBe('opened');
  });

  it('does not write labels when the requested workflow state is already present', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::qa', 'mode::afk', 'team::api'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await provider.transition('42', 'verification');

    expect(t.updateLabels).not.toHaveBeenCalled();
  });

  it('updates workflow labels and closes the tracker issue when transitioning to done', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::qa', 'mode::afk', 'team::api'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await provider.transition('42', 'done');

    expect(t.updateLabels).toHaveBeenCalledWith(42, {
      add: ['stage::done'],
      remove: ['stage::qa'],
    });
    expect(t.updateIssue).toHaveBeenCalledWith(42, { state: 'closed' });
    expect(issue.state).toBe('closed');
  });

  it('maps a closed issue with a stale ready label to done', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'closed', url: '', projectId: '' };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn() });

    await expect(provider.get('42')).resolves.toMatchObject({ state: 'done' });
  });

  it('maps a merged issue with a stale ready label to done', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'merged', url: '', projectId: '' };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn() });

    await expect(provider.get('42')).resolves.toMatchObject({ state: 'done' });
  });

  it('returns null when a second claim observes in-progress state', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const atomicClaim = vi.fn(async () => {
      if (!issue.labels.includes('stage::ready-for-issues')) return false;
      issue.labels = ['stage::afk-in-progress', 'mode::afk'];
      return true;
    });
    const provider = new TrackerBacklogProvider(t, { atomicClaim });
    const first = await provider.claim('42', 'one');
    const second = await provider.claim('42', 'two');
    expect(first?.item.state).toBe('in_progress');
    expect(second).toBeNull();
  });

  it('passes the complete canonical predicate to the atomic claim capability', async () => {
    const dependency = { id: 9, title: 'Dependency', description: '', labels: ['stage::done'], state: 'opened', url: '', projectId: '' };
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'depends-on::9'], state: 'opened', url: '', projectId: '' };
    const atomicClaim = vi.fn(async () => { issue.labels = ['stage::afk-in-progress', 'mode::afk', 'depends-on::9']; return true; });
    const t = tracker(issue);
    t.listIssues = vi.fn(async () => [{ ...issue }, dependency]);
    t.getIssue = vi.fn(async id => id === 9 ? { ...dependency } : { ...issue });
    const provider = new TrackerBacklogProvider(t, { atomicClaim });
    await provider.claim('42', 'worker');
    expect(atomicClaim).toHaveBeenCalledWith('42', 'worker', 'ready', {
      state: 'ready', executionMode: 'afk', parentId: undefined, dependencies: ['github:org/repo#9'],
    });
  });

  it('allows a child backlog to claim natively and includes its parent in the predicate', async () => {
    const issue = { id: 42, title: 'Child', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'parent::10'], state: 'opened', url: '', projectId: '' };
    const atomicClaim = vi.fn(async () => { issue.labels = ['stage::afk-in-progress', 'mode::afk', 'parent::10']; return true; });
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim });

    await expect(provider.claim('42', 'worker')).resolves.toMatchObject({
      item: { id: 'github:org/repo#42', parentId: 'github:org/repo#10', state: 'in_progress' },
    });

    expect(atomicClaim).toHaveBeenCalledWith('42', 'worker', 'ready', expect.objectContaining({ parentId: 'github:org/repo#10' }));
  });

  it('keeps a parent backlog non-runnable after every tracker child is done', async () => {
    const parent = { id: 10, title: 'Parent', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const child = { id: 42, title: 'Child', description: '', labels: ['stage::done', 'parent::10'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(parent);
    t.listIssues = vi.fn(async () => [{ ...parent }, { ...child }]);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await expect(provider.isRunnable(await provider.get('10'))).resolves.toBe(false);
  });

  it('keeps a parent non-runnable when its child lives in another repository', async () => {
    const parent = { id: 10, title: 'Parent', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(parent);
    t.listIssues = vi.fn(async () => [{ ...parent }]);
    const graph = {
      childrenOf: vi.fn(async () => [{
        id: 'gitlab:group/other#42', issueNumber: 42, title: 'Child', state: 'ready' as const,
        executionMode: 'afk' as const, tags: [], dependsOn: [], branchName: 'afk/backlog-42',
        providerRef: 'gitlab:group/other#42', parentId: 'github:org/repo#10',
      }]),
    };
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn(), graph });

    await expect(provider.isRunnable(await provider.get('10'))).resolves.toBe(false);
    expect(graph.childrenOf).toHaveBeenCalledWith('github:org/repo#10');
  });

  it('falls back to the local project scan when the cross-project graph cannot be read', async () => {
    const parent = { id: 10, title: 'Parent', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const child = { id: 42, title: 'Child', description: '', labels: ['stage::done', 'parent::10'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(parent);
    t.listIssues = vi.fn(async () => [{ ...parent }, { ...child }]);
    const onGraphError = vi.fn();
    const provider = new TrackerBacklogProvider(t, {
      atomicClaim: vi.fn(),
      graph: { childrenOf: vi.fn(async () => { throw new Error('inventory unavailable'); }) },
      onGraphError,
    });

    await expect(provider.isRunnable(await provider.get('10'))).resolves.toBe(false);
    expect(onGraphError).toHaveBeenCalled();
  });

  it('maps a closed issue without workflow labels to done for dependency checks', async () => {
    const issue = { id: 9, title: 'Dependency', description: '', labels: [], state: 'closed', url: '', projectId: '' };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn() });
    await expect(provider.get('9')).resolves.toMatchObject({ state: 'done' });
  });

  it('fetches MR changes once for the whole list instead of once per merge-ready item', async () => {
    const mergeReady = (id: number) => ({
      id, title: `Item ${id}`, description: '',
      labels: ['stage::merge-ready', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo',
    });
    const issues = [mergeReady(1), mergeReady(2), mergeReady(3)];
    const t = tracker(issues[0]);
    t.listIssues = vi.fn(async () => issues);
    const listMRs = vi.fn(async () => []);
    t.listMRs = listMRs;
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    const items = await provider.list();
    expect(items).toHaveLength(3);
    expect(listMRs).toHaveBeenCalledTimes(1);
  });

  it('exposes business tags while hiding provider workflow metadata', async () => {
    const issue = { id: 7, title: 'Tagged', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'team::api'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });
    await expect(provider.get('7')).resolves.toMatchObject({ tags: ['team::api'] });
    await provider.addTag('7', 'urgent');
    await provider.removeTag('7', 'team::api');
    expect(issue.labels).toEqual(['stage::ready-for-issues', 'mode::afk', 'urgent']);
    expect(t.updateLabels).toHaveBeenCalledWith(7, { add: ['urgent'], remove: [] });
    expect(t.updateLabels).toHaveBeenCalledWith(7, { add: [], remove: ['team::api'] });
    expect(t.updateIssue).not.toHaveBeenCalled();
    await expect(provider.list({ tag: 'urgent' })).resolves.toHaveLength(1);
  });

  it('initializes provider metadata idempotently and reports capabilities', async () => {
    const ensureMetadata = vi.fn(async () => {});
    const t = tracker({ id: 1, title: 'Item', description: '', labels: [], state: 'opened', url: '', projectId: '' });
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn(), ensureMetadata });
    await provider.initialize();
    await provider.initialize();
    expect(ensureMetadata).toHaveBeenCalledTimes(2);
    expect(provider.capabilities).toEqual({ atomicClaim: true, tags: true, initialization: true });
  });

  it('appends a QA rework record and resolves that exact comment without overwriting history', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::qa', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue) as any;
    const comments: Array<{ id: string; body: string }> = [];
    t.listIssueComments = vi.fn(async () => comments.map(comment => ({ ...comment })));
    t.addComment = vi.fn(async (_id: number, body: string) => { comments.push({ id: 'comment-1', body }); });
    t.updateIssueComment = vi.fn(async (_id: number, commentId: string, body: string) => {
      const comment = comments.find(candidate => candidate.id === commentId);
      if (comment) comment.body = body;
    });
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    const record = await provider.createRework('42', {
      source: 'qa',
      summary: 'The required /s key sequence was not implemented.',
      failedCriteria: [{ id: 'search-shortcut', expected: '/ then s enters search', actual: '/ alone enters search' }],
      requiredChecks: [{ command: 'PTY / then s', expected: 'search mode is active' }],
    });
    await provider.resolveRework('42', record.id, { summary: 'Verified by QA run qa-42-r2.' });

    expect(record).toMatchObject({ id: 'r1', attempt: 1, status: 'open' });
    expect(t.addComment).toHaveBeenCalledWith(42, expect.stringContaining('<!-- afk:rework:v1 id=r1 -->'));
    expect(t.updateIssueComment).toHaveBeenCalledWith(42, 'comment-1', expect.stringContaining('"status":"resolved"'));
    await expect(provider.get('42')).resolves.toMatchObject({ state: 'verification', executionMode: 'afk' });
  });

  it('allows operator retry to supersede an open QA record and keeps operator duplicates blocked', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::qa', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue) as any;
    const comments: Array<{ id: string; body: string }> = [];
    t.listIssueComments = vi.fn(async () => comments.map(comment => ({ ...comment })));
    t.addComment = vi.fn(async (_id: number, body: string) => { comments.push({ id: `comment-${comments.length + 1}`, body }); });
    t.updateIssueComment = vi.fn(async (_id: number, commentId: string, body: string) => {
      const comment = comments.find(candidate => candidate.id === commentId);
      if (comment) comment.body = body;
    });
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });

    await provider.createRework('42', { source: 'qa', summary: 'QA failure', failedCriteria: [], requiredChecks: [] });
    const retry = await provider.createRework('42', { source: 'operator', summary: 'manual retry', failedCriteria: [], requiredChecks: [] });

    expect(retry).toMatchObject({ id: 'r2', source: 'operator', status: 'open' });
    await expect(provider.getActiveRework('42')).resolves.toMatchObject({ id: 'r2', source: 'operator' });
    await expect(provider.createRework('42', { source: 'operator', summary: 'duplicate retry', failedCriteria: [], requiredChecks: [] }))
      .rejects.toThrow('already has an open rework record');
    expect(comments.map(comment => comment.body)).toEqual([
      expect.stringContaining('"status":"superseded"'),
      expect.stringContaining('"status":"open"'),
    ]);
    await expect(provider.get('42')).resolves.toMatchObject({ state: 'rework', executionMode: 'afk' });
  });

  it('does not change the active record when writing a new rework fails', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::qa', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue) as any;
    const comments: Array<{ id: string; body: string }> = [];
    t.listIssueComments = vi.fn(async () => comments.map(comment => ({ ...comment })));
    t.addComment = vi.fn(async (_id: number, body: string) => { comments.push({ id: 'comment-1', body }); });
    t.updateIssueComment = vi.fn(async (_id: number, commentId: string, body: string) => {
      const comment = comments.find(candidate => candidate.id === commentId);
      if (comment) comment.body = body;
    });
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });
    await provider.createRework('42', { source: 'qa', summary: 'QA failure', failedCriteria: [], requiredChecks: [] });
    t.addComment.mockRejectedValueOnce(new Error('tracker write failed'));

    await expect(provider.createRework('42', { source: 'operator', summary: 'manual retry', failedCriteria: [], requiredChecks: [] }))
      .rejects.toThrow('tracker write failed');
    expect(t.updateIssueComment).not.toHaveBeenCalled();
    await expect(provider.getActiveRework('42')).resolves.toMatchObject({ id: 'r1', source: 'qa' });
  });

  it('supersedes the new record when superseding the old record fails, allowing a later operator retry', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::qa', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue) as any;
    const comments: Array<{ id: string; body: string }> = [];
    t.listIssueComments = vi.fn(async () => comments.map(comment => ({ ...comment })));
    t.addComment = vi.fn(async (_id: number, body: string) => { comments.push({ id: `comment-${comments.length + 1}`, body }); });
    t.updateIssueComment = vi.fn(async (_id: number, commentId: string, body: string) => {
      if (commentId === 'comment-1' && t.updateIssueComment.mock.calls.length === 1) throw new Error('supersede failed');
      const comment = comments.find(candidate => candidate.id === commentId);
      if (comment) comment.body = body;
    });
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });
    await provider.createRework('42', { source: 'qa', summary: 'QA failure', failedCriteria: [], requiredChecks: [] });

    await expect(provider.createRework('42', { source: 'operator', summary: 'manual retry', failedCriteria: [], requiredChecks: [] }))
      .rejects.toThrow('supersede failed');
    await expect(provider.getActiveRework('42')).resolves.toMatchObject({ id: 'r1', source: 'qa' });
    expect(comments[1].body).toContain('"status":"superseded"');

    const retry = await provider.createRework('42', { source: 'operator', summary: 'manual retry again', failedCriteria: [], requiredChecks: [] });
    expect(retry).toMatchObject({ id: 'r3', source: 'operator', status: 'open' });
    await expect(provider.getActiveRework('42')).resolves.toMatchObject({ id: 'r3', source: 'operator' });
  });

  it('uses a filesystem lease to serialize tracker claims without native CAS', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    let held = false;
    const claimLock = {
      acquire: vi.fn(async (): Promise<ClaimLease | null> => {
        if (held) return null;
        held = true;
        return lease('fallback-claim', () => { held = false; });
      }),
    };
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLock });

    const [first, second] = await Promise.all([provider.claim('42', 'worker-a'), provider.claim('42', 'worker-b')]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(claimLock.acquire).toHaveBeenCalledWith(expect.objectContaining({
      key: 'github/org/repo/42', owner: expect.any(String),
    }));
    await first?.release();
    await second?.release();
  });

  it('allows a child backlog to claim through the filesystem fallback', async () => {
    const issue = { id: 42, title: 'Child', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'parent::10'], state: 'opened', url: '', projectId: 'org/repo' };
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLock: { acquire: vi.fn(async () => lease('fallback-child')) } });

    await expect(provider.claim('42', 'worker')).resolves.toMatchObject({
      item: { id: 'github:org/repo#42', parentId: 'github:org/repo#10', state: 'in_progress' },
    });
  });

  it('uses native CAS without acquiring a fallback lease', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const claimLock = { acquire: vi.fn(async (): Promise<ClaimLease | null> => lease('unexpected-lock')) };
    const atomicClaim = vi.fn(async () => {
      issue.labels = ['stage::afk-in-progress', 'mode::afk'];
      return true;
    });
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim, claimLock });

    await provider.claim('42', 'worker-a');

    expect(claimLock.acquire).not.toHaveBeenCalled();
  });

  it('releases a fallback lease when the item cannot be claimed', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::hitl'], state: 'opened', url: '', projectId: 'org/repo' };
    const release = vi.fn(async () => {});
    const claimLock = { acquire: vi.fn(async (): Promise<ClaimLease | null> => ({ ...lease('fallback-claim'), release })) };
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLock });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('blocks and routes a native claim when post-CAS confirmation fails', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn(async () => true) });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
  });

  it('blocks a native claim when CAS rejects after an unknown provider-side commit', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const atomicClaim = vi.fn(async () => {
      issue.labels = ['stage::afk-in-progress', 'mode::afk'];
      throw new Error('CAS response lost');
    });
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim });

    await expect(provider.claim('42', 'worker-a')).rejects.toThrow('CAS response lost');

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
  });

  it('blocks and releases a fallback lease when post-transition confirmation fails', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue);
    t.updateLabels = vi.fn(async (_id, delta) => {
      if (delta.add.includes('stage::blocked')) issue.labels = ['stage::blocked', 'mode::hitl'];
    });
    const release = vi.fn(async () => {});
    const provider = new TrackerBacklogProvider(t, { claimLock: { acquire: vi.fn(async () => ({ ...lease('fallback-claim'), release })) } });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('blocks and releases a fallback lease when post-transition re-read throws', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue);
    let reads = 0;
    t.getIssue = vi.fn(async () => {
      reads += 1;
      if (reads === 3) throw new Error('post-transition read failed');
      return { ...issue };
    });
    const release = vi.fn(async () => {});
    const provider = new TrackerBacklogProvider(t, { claimLock: { acquire: vi.fn(async () => ({ ...lease('fallback-claim'), release })) } });

    await expect(provider.claim('42', 'worker-a')).rejects.toThrow('post-transition read failed');

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('blocks and routes an expired fallback lease to the exact provider-qualified backlog', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    let recoveryKey: string | undefined;
    const claimLockFactory = vi.fn((onExpiredClaim: (key: string) => Promise<boolean>) => ({
      acquire: vi.fn(async ({ key }: { key: string }): Promise<ClaimLease | null> => {
        recoveryKey = key;
        await onExpiredClaim(key);
        return null;
      }),
    }));
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLockFactory });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(recoveryKey).toBe('github/org/repo/42');
    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
  });
});

function lease(claimId: string, onRelease: () => void = () => {}): ClaimLease {
  return { claimId, heartbeat: async () => {}, release: async () => { onRelease(); } };
}
