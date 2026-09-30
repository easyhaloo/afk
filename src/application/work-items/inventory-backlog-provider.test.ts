import { describe, expect, it, vi } from 'vitest';
import { InventoryBacklogProvider, isProjectDetectionFailure } from './inventory-backlog-provider';
import type { ProviderCatalog } from './types';
import type { ProviderProjectRef } from '../../domain/work-item/types';
import { BACKLOG_METADATA } from '../../domain/backlog/initialization';
import type { TrackerProvider } from '../../domain/tracker/types';

const project: ProviderProjectRef = {
  platform: 'github',
  projectKey: 'acme/app',
  name: 'app',
  defaultBranch: 'main',
};

function fakeCatalog(issues: { number: number; title: string; labels: string[]; state: 'open' | 'closed' }[]): ProviderCatalog {
  return {
    platform: 'github',
    scopeKey: 'github.com',
    async listProjects() { return [project]; },
    async listIssues() {
      return issues.map(issue => ({
        issueNumber: issue.number,
        title: issue.title,
        labels: issue.labels,
        state: issue.state === 'open' ? 'opened' as const : 'closed' as const,
        webUrl: `https://github.com/acme/app/issues/${issue.number}`,
      }));
    },
  };
}

function managedLabels(state: keyof typeof BACKLOG_METADATA.stateLabels = 'ready', mode: 'afk' | 'hitl' = 'afk'): string[] {
  return [BACKLOG_METADATA.stateLabels[state], BACKLOG_METADATA.executionModeLabels[mode], 'billing'];
}

describe('InventoryBacklogProvider', () => {
  it('lists only AFK-managed issues with canonical global identity', async () => {
    const provider = new InventoryBacklogProvider({
      catalogs: () => [fakeCatalog([
        { number: 7, title: 'Managed task', labels: managedLabels(), state: 'open' },
        { number: 8, title: 'Plain issue', labels: ['bug'], state: 'open' },
      ])],
    });
    const items = await provider.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'github:acme/app#7',
      workItemId: 'github:acme/app#7',
      issueNumber: 7,
      managed: true,
      executionEligible: true,
      state: 'ready',
      executionMode: 'afk',
      tags: ['billing'],
    });
  });

  it('applies state, mode, tag, and parent filters', async () => {
    const provider = new InventoryBacklogProvider({
      catalogs: () => [fakeCatalog([
        { number: 1, title: 'Ready afk', labels: managedLabels('ready', 'afk'), state: 'open' },
        { number: 2, title: 'Blocked hitl', labels: managedLabels('blocked', 'hitl'), state: 'open' },
      ])],
    });
    expect((await provider.list({ state: 'blocked' })).map(item => item.id)).toEqual(['github:acme/app#2']);
    expect((await provider.list({ executionMode: 'afk' })).map(item => item.id)).toEqual(['github:acme/app#1']);
    expect((await provider.list({ tag: 'billing' })).map(item => item.id)).toEqual(['github:acme/app#1', 'github:acme/app#2']);
    expect(await provider.list({ parentId: 'github:acme/app#9' })).toEqual([]);
  });

  it('resolves a canonical backlog id through a project-scoped tracker', async () => {
    const tracker: TrackerProvider = {
      platform: 'github',
      projectId: 'acme/app',
      getIssue: vi.fn(async () => ({
        id: 7,
        platform: 'github' as const,
        title: 'Managed task',
        description: 'body',
        labels: managedLabels(),
        state: 'opened' as const,
        url: 'https://github.com/acme/app/issues/7',
        projectId: 'acme/app',
      })),
    } as unknown as TrackerProvider;
    const provider = new InventoryBacklogProvider({
      catalogs: () => [],
      trackerFor: async () => tracker,
    });
    const item = await provider.get('github:acme/app#7');
    expect(item).toMatchObject({ id: 'github:acme/app#7', title: 'Managed task', state: 'ready' });
  });

  it('rejects non-canonical ids and project-bound mutations in global mode', async () => {
    const provider = new InventoryBacklogProvider({ catalogs: () => [] });
    await expect(provider.get('42')).rejects.toThrow(/规范 ID/);
    await expect(provider.create({ title: 't', description: 'd' })).rejects.toThrow(/--project/);
    await expect(provider.addTag('1', 'x')).rejects.toThrow(/--project/);
    await expect(provider.removeTag('1', 'x')).rejects.toThrow(/--project/);
  });
});

describe('isProjectDetectionFailure', () => {
  it.each([
    new Error('No git remote found. Cannot detect platform.'),
    new Error('Could not determine GitHub repository. Pass owner/repo or run inside a GitHub repository.'),
    new Error('Could not determine GitLab project. Pass the project path or run inside a GitLab repository.'),
    new Error('Could not detect github project from git remote'),
  ])('matches %s', error => {
    expect(isProjectDetectionFailure(error)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isProjectDetectionFailure(new Error('Provider authentication is required.'))).toBe(false);
  });
});
