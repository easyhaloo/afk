import { describe, expect, it, vi } from 'vitest';
import { collectGlobalWorkItemInventory, filterGlobalWorkItemInventory } from './inventory';
import type { ProviderCatalog, ProviderIssue } from './types';

function catalog(
  platform: 'github' | 'gitlab',
  scopeKey: string,
  projects: ProviderCatalog['listProjects'] extends () => Promise<infer T> ? T : never,
  issues: Record<string, ProviderIssue[] | Error>,
): ProviderCatalog {
  return {
    platform,
    scopeKey,
    listProjects: vi.fn(async () => projects),
    listIssues: vi.fn(async project => {
      const result = issues[project.projectKey] ?? [];
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('global work item inventory', () => {
  it('keeps identical issue numbers distinct across projects', async () => {
    const source = catalog('github', 'github.com', [
      { platform: 'github', projectKey: 'acme/api', name: 'api' },
      { platform: 'github', projectKey: 'acme/web', name: 'web' },
    ], {
      'acme/api': [{ issueNumber: 9, title: 'API', labels: [], state: 'opened' }],
      'acme/web': [{ issueNumber: 9, title: 'Web', labels: [], state: 'opened' }],
    });

    const result = await collectGlobalWorkItemInventory([source]);

    expect(result.items.map(item => item.id)).toEqual([
      'github:acme/api#9',
      'github:acme/web#9',
    ]);
  });

  it('keeps successful projects when another project fails', async () => {
    const source = catalog('gitlab', 'gitlab.example.com', [
      { platform: 'gitlab', projectKey: 'gitlab.example.com/a/good', name: 'good' },
      { platform: 'gitlab', projectKey: 'gitlab.example.com/z/broken', name: 'broken' },
    ], {
      'gitlab.example.com/a/good': [{ issueNumber: 2, title: 'Kept', labels: [], state: 'opened' }],
      'gitlab.example.com/z/broken': new Error('HTTP 503'),
    });

    const result = await collectGlobalWorkItemInventory([source]);

    expect(result.complete).toBe(false);
    expect(result.items.map(item => item.title)).toEqual(['Kept']);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        platform: 'gitlab',
        projectKey: 'gitlab.example.com/z/broken',
        code: 'issue_list_failed',
        message: 'HTTP 503',
        retryable: true,
      }),
    ]);
  });

  it('sorts projects and items deterministically regardless of provider order', async () => {
    const github = catalog('github', 'github.com', [
      { platform: 'github', projectKey: 'z/repo', name: 'z' },
      { platform: 'github', projectKey: 'a/repo', name: 'a' },
    ], {
      'z/repo': [{ issueNumber: 10, title: 'ten', labels: [], state: 'opened' }],
      'a/repo': [
        { issueNumber: 12, title: 'twelve', labels: [], state: 'opened' },
        { issueNumber: 2, title: 'two', labels: [], state: 'opened' },
      ],
    });
    const gitlab = catalog('gitlab', 'gitlab.com', [
      { platform: 'gitlab', projectKey: 'gitlab.com/b/repo', name: 'b' },
    ], {
      'gitlab.com/b/repo': [{ issueNumber: 1, title: 'one', labels: [], state: 'opened' }],
    });

    const result = await collectGlobalWorkItemInventory([gitlab, github]);

    expect(result.projects.map(project => `${project.platform}:${project.projectKey}`)).toEqual([
      'github:a/repo',
      'github:z/repo',
      'gitlab:gitlab.com/b/repo',
    ]);
    expect(result.items.map(item => item.id)).toEqual([
      'github:a/repo#2',
      'github:a/repo#12',
      'github:z/repo#10',
      'gitlab:gitlab.com/b/repo#1',
    ]);
  });

  it('returns partial pages with diagnostics at catalog and issue scope', async () => {
    const project = { platform: 'github' as const, projectKey: 'acme/api', name: 'api' };
    const source: ProviderCatalog = {
      platform: 'github', scopeKey: 'github.com',
      async listProjects() { return { items: [project], error: new Error('HTTP 503 projects') }; },
      async listIssues() {
        return { items: [{ issueNumber: 3, title: 'kept', labels: [], state: 'opened' as const }], error: new Error('HTTP 503 issues') };
      },
    };

    const result = await collectGlobalWorkItemInventory([source]);
    expect(result.projects).toEqual([project]);
    expect(result.items.map(item => item.id)).toEqual(['github:acme/api#3']);
    expect(result.diagnostics.map(diagnostic => [diagnostic.projectKey, diagnostic.code])).toEqual([
      ['acme/api', 'issue_list_failed'], ['github.com', 'project_list_failed'],
    ]);
    expect(result.complete).toBe(false);
  });

  it('limits simultaneous project discovery to the requested concurrency', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const sources: ProviderCatalog[] = Array.from({ length: 6 }, (_, index) => ({
      platform: 'gitlab', scopeKey: `host-${index}`,
      listProjects: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>(resolve => release.push(resolve));
        active -= 1;
        return [];
      }),
      async listIssues() { return []; },
    }));

    const pending = collectGlobalWorkItemInventory(sources, 2);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    expect(peak).toBe(2);
    for (let index = 0; index < sources.length; index += 2) {
      release[index]();
      release[index + 1]();
      if (index + 2 < sources.length) await vi.waitFor(() => expect(release).toHaveLength(index + 4));
    }
    await pending;
    expect(peak).toBe(2);
  });

  it('recomputes complete after filtering out unrelated project failures', async () => {
    const source = catalog('github', 'github.com', [
      { platform: 'github', projectKey: 'acme/good', name: 'good' },
      { platform: 'github', projectKey: 'acme/bad', name: 'bad' },
    ], { 'acme/bad': new Error('HTTP 503') });
    const result = filterGlobalWorkItemInventory(await collectGlobalWorkItemInventory([source]), { project: 'acme/good' });

    expect(result.projects.map(project => project.projectKey)).toEqual(['acme/good']);
    expect(result.diagnostics).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('retains host-level discovery diagnostics for a matching project filter', () => {
    const result = filterGlobalWorkItemInventory({
      items: [], projects: [], complete: false,
      diagnostics: [{ platform: 'gitlab', projectKey: 'gitlab.corp', code: 'project_list_failed', message: 'timeout', retryable: true }],
    }, { project: 'gitlab.corp/group/api' });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
});
