import { describe, expect, it, vi } from 'vitest';
import type { TrackerProjectReader } from '@afk/application';
import { fetchProjectDetail } from './fetcher.js';

/**
 * The board reads a project's branches, tags and commits.  It does not read
 * issues, it does not write, and it does not know what a merge request is.
 * The reader is a parameter so that dependency is the one the board declares.
 */
describe('dashboard project detail', () => {
  it('reads branches, tags and commits from the reader it is given', async () => {
    const reader: TrackerProjectReader = {
      platform: 'gitlab',
      projectId: 'group/project',
      listProjects: vi.fn(async () => []),
      getBranches: vi.fn(async () => [{ name: 'main', commit: 'abc1234', commit_title: 'init' }]),
      getTags: vi.fn(async () => [{ name: 'v1.0.0', commit: 'def5678', author: 'afk', committed_date: '2026-01-01' }]),
      getRecentCommits: vi.fn(async () => [{ id: 'abc1234', title: 'init', author: 'afk', committed_date: '2026-01-01' }]),
    };

    await expect(fetchProjectDetail(42, reader)).resolves.toEqual({
      branches: [{ name: 'main', commit: 'abc1234', commit_title: 'init' }],
      tags: [{ name: 'v1.0.0', commit: 'def5678', author: 'afk', committed_date: '2026-01-01' }],
      commits: [{ id: 'abc1234', title: 'init', author: 'afk', committed_date: '2026-01-01' }],
    });
    expect(reader.getBranches).toHaveBeenCalledWith(42);
    expect(reader.getTags).toHaveBeenCalledWith(42);
    expect(reader.getRecentCommits).toHaveBeenCalledWith(42, 5);
  });
});
