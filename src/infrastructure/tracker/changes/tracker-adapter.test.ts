import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../domain/backlog';
import type { TrackerProvider } from '../../../domain/tracker/types';
import { renderChangeDescription, TrackerChangeProvider } from './tracker-adapter';

describe('TrackerChangeProvider', () => {
  it('qualifies cross-repository issues without copying the PRD', () => {
    const backlog = { id: '158', title: 'Item', description: '# PRD', workItemId: 'github:owner/issues#158' } as BacklogItem;
    expect(renderChangeDescription(backlog, { platform: 'github', projectId: 'owner/issues' })).toBe('QA: PASS\nCloses #158');
    expect(renderChangeDescription(backlog, { platform: 'github', projectId: 'owner/code' })).toBe('QA: PASS\nCloses owner/issues#158');
    expect(() => renderChangeDescription(backlog, { platform: 'gitlab', projectId: 'owner/code' })).toThrow(/platform/i);
    expect(() => renderChangeDescription({ ...backlog, id: '159' }, { platform: 'github', projectId: 'owner/code' })).toThrow(/issue/i);
  });

  it('uses GitLab project path for qualified cross-project references', () => {
    const backlog = { id: '158', workItemId: 'gitlab:gitlab.example.test/team/issues#158' } as BacklogItem;
    expect(renderChangeDescription(backlog, { platform: 'gitlab', projectId: 'team/code', providerHost: 'gitlab.example.test' })).toBe('QA: PASS\nCloses team/issues#158');
  });

  it('publishes the qualified two-line reference without the PRD', async () => {
    const tracker = {
      platform: 'github', projectId: 'owner/code',
      createMR: vi.fn().mockResolvedValue(9),
      getMR: vi.fn().mockResolvedValue({ id: 9, state: 'opened', sourceBranch: 'qa', targetBranch: 'main', url: 'https://github.com/owner/code/pull/9' }),
    } as unknown as TrackerProvider;
    await new TrackerChangeProvider(tracker).create({
      backlog: { id: '158', title: 'Item', description: '# PRD secret', workItemId: 'github:owner/issues#158' } as BacklogItem,
      sourceBranch: 'qa', targetBranch: 'main',
    });
    expect(tracker.createMR).toHaveBeenCalledWith(expect.objectContaining({ description: 'QA: PASS\nCloses owner/issues#158' }));
  });

  it('verifies the exact canonical issue through provider-native readback', async () => {
    const tracker = {
      platform: 'github', projectId: 'owner/code',
      getMR: vi.fn().mockResolvedValue({ id: 9, state: 'opened', sourceBranch: 'qa', targetBranch: 'main', url: 'https://github.com/owner/code/pull/9' }),
      isMRLinkedToIssue: vi.fn().mockResolvedValue(true),
    } as unknown as TrackerProvider;
    const change = { id: '9', state: 'open' as const, sourceBranch: 'qa', targetBranch: 'main', url: 'https://github.com/owner/code/pull/9' };
    const provider = new TrackerChangeProvider(tracker);
    await expect(provider.verifyIssueAssociation(change, 'github:owner/issues#158')).resolves.toBeUndefined();
    expect(tracker.isMRLinkedToIssue).toHaveBeenCalledWith(9, 'github:owner/issues#158');
    vi.mocked(tracker.isMRLinkedToIssue).mockResolvedValue(false);
    await expect(provider.verifyIssueAssociation(change, 'github:owner/issues#158')).rejects.toThrow(/not linked/i);
    await expect(provider.verifyIssueAssociation({ ...change, url: 'https://github.com/owner/code/pull/8' }, 'github:owner/issues#158')).rejects.toThrow(/mismatch/i);
    vi.mocked(tracker.isMRLinkedToIssue).mockRejectedValue(new Error('API unavailable'));
    await expect(provider.verifyIssueAssociation(change, 'github:owner/issues#158')).rejects.toThrow('API unavailable');
  });

  it('uses only the QA result and issue closing reference, without repeating the PRD', () => {
    const backlog = {
      id: '158', title: '工作项列表排序', description: '# PRD\n\n大量需求正文',
      webUrl: 'https://github.com/easyhaloo/afk/issues/158',
    } as BacklogItem;

    expect(renderChangeDescription(backlog)).toBe(
      'QA: PASS\nCloses #158',
    );
  });

  it('creates a concise change description that closes the source backlog', async () => {
    const tracker = {
      createMR: vi.fn().mockResolvedValue(159),
      getMR: vi.fn().mockResolvedValue({
        id: 159,
        state: 'opened',
        sourceBranch: 'afk/backlog-158-qa',
        targetBranch: 'main',
        url: 'https://example.test/pull/159',
      }),
    } as unknown as TrackerProvider;
    const backlog = {
      id: '158',
      title: '工作项列表排序',
      description: '# PRD\n\n大量需求正文',
      branchName: 'afk/backlog-158',
      webUrl: 'https://example.test/issues/158',
    } as BacklogItem;

    await new TrackerChangeProvider(tracker).create({
      backlog,
      sourceBranch: 'afk/backlog-158-qa',
      targetBranch: 'main',
    });

    expect(tracker.createMR).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Backlog 158: 工作项列表排序',
      description: expect.stringContaining('Closes #158'),
    }));
    expect(tracker.createMR).not.toHaveBeenCalledWith(expect.objectContaining({ description: backlog.description }));
  });

  it('prefers the QA verification change for a root backlog', async () => {
    const tracker = {
      listMRs: vi.fn().mockResolvedValue([
        { id: 8, state: 'opened', sourceBranch: 'afk/backlog-42', targetBranch: 'main' },
        { id: 9, state: 'opened', sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' },
      ]),
      getMR: vi.fn().mockResolvedValue({
        id: 9,
        state: 'opened',
        sourceBranch: 'afk/backlog-42-qa',
        targetBranch: 'main',
        mergeable: true,
        url: 'https://example.test/mr/9',
      }),
    } as unknown as TrackerProvider;
    const backlog = { id: '42', branchName: 'afk/backlog-42' } as BacklogItem;

    await expect(new TrackerChangeProvider(tracker).findForBacklog(backlog)).resolves.toMatchObject({
      id: '9',
      sourceBranch: 'afk/backlog-42-qa',
    });
    expect(tracker.getMR).toHaveBeenCalledWith(9);
  });

  it('finds a merged backlog change from the all-state listing and refreshes its true state', async () => {
    const tracker = {
      listMRs: vi.fn().mockResolvedValue([{
        id: 9,
        state: 'closed',
        sourceBranch: 'afk/backlog-42',
        targetBranch: 'main',
      }]),
      getMR: vi.fn().mockResolvedValue({
        id: 9,
        state: 'merged',
        sourceBranch: 'afk/backlog-42',
        targetBranch: 'main',
        mergeable: true,
        url: 'https://example.test/mr/9',
      }),
    } as unknown as TrackerProvider;
    const backlog = { id: '42', branchName: 'afk/backlog-42' } as BacklogItem;

    await expect(new TrackerChangeProvider(tracker).findForBacklog(backlog)).resolves.toMatchObject({
      id: '9',
      state: 'merged',
      mergeable: true,
    });
    expect(tracker.listMRs).toHaveBeenCalledWith({ state: 'all' });
    expect(tracker.getMR).toHaveBeenCalledWith(9);
  });
});
