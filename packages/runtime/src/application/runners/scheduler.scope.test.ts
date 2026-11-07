import { describe, expect, it, vi } from 'vitest';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';
import type { GlobalWorkItemInventoryResult, InventoryDiagnostic } from '../../domain/work-item/provider-types.js';

/**
 * The platform read, stubbed at the seam the scheduler actually uses.
 *
 * The other scheduler tests hand the scheduler an inventory. This file hands
 * it the *platform*: the items the provider reported together with the
 * diagnostics it reported about them. That is the shape of the real read,
 * and it is where the old "one broken project blinds the whole PRD" verdict
 * lived.
 */
const platform = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock('../../infrastructure/provider/tracker-provider-factory.js', () => ({
  createGlobalWorkItemCatalogs: () => [{
    platform: 'github',
    scopeKey: 'github.com',
    listProjects: async () => [],
    listIssues: async () => [],
  }],
}));

vi.mock('../../infrastructure/provider/inventory.js', () => ({
  collectGlobalWorkItemInventory: async () => platform.result,
}));

import { scheduleWorkItems } from './scheduler.js';

function item(project: string, number: number, overrides: Partial<GlobalWorkItem> = {}): GlobalWorkItem {
  const id = parseWorkItemId(`github:${project}#${number}`).id;
  return { id, issueNumber: number, project: { platform: 'github', projectKey: project, name: project },
    title: id, managed: true, executionEligible: true, state: 'ready', executionMode: 'afk',
    dependsOn: [], tags: [], branchName: `afk/${number}`, providerRef: id, ...overrides };
}

/** A PRD with one slice that stands on its own and one that waits for another repository. */
function tree() {
  const parent = item('acme/prd', 1, { kind: 'prd' });
  const standalone = item('acme/api', 2, { parentId: parent.id });
  const dependent = item('acme/web', 3, { parentId: parent.id, dependsOn: ['github:acme/base#9'] });
  return { parent, standalone, dependent };
}

function platformRead(items: GlobalWorkItem[], diagnostics: InventoryDiagnostic[]): GlobalWorkItemInventoryResult {
  return { items, projects: [], diagnostics, complete: diagnostics.length === 0 };
}

/**
 * A wait that ends the schedule after the second pause.
 *
 * The schedule keeps looking until it is stopped, and the test says so: the
 * second pause ends it. The pause count also keeps the test bounded when the
 * read fails — an old scheduler that backs off forever would otherwise hang
 * the test instead of failing it.
 */
function schedulerStop() {
  const controller = new AbortController();
  let pauses = 0;
  const wait = vi.fn(async () => {
    pauses += 1;
    if (pauses >= 2) controller.abort();
  });
  return { controller, wait };
}

describe('a schedule against a platform that has a broken project', () => {
  it('dispatches the slices that do not depend on a project outside the range', async () => {
    const { parent, standalone, dependent } = tree();
    platform.result = platformRead([parent, standalone, dependent], [
      { platform: 'github', projectKey: 'other/repo', code: 'issue_list_failed', message: 'Repository access blocked', retryable: false },
    ]);
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => ({ workItemId, executionId: 'attempt', status: 'merge_ready' as const }));
    const { controller, wait } = schedulerStop();

    const result = await scheduleWorkItems({ parent: parent.id, signal: controller.signal }, {
      repositories: async subject => [subject.project.projectKey], load: () => 0, execute, wait,
    });

    // The broken project is named, and it does not stop the schedule.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ workItemId: standalone.id });
    expect(result.scope?.reported.map(diagnostic => diagnostic.projectKey)).toEqual(['other/repo']);
  });

  it('holds back the slice that depends on a broken project inside the range', async () => {
    const { parent, standalone, dependent } = tree();
    platform.result = platformRead([parent, standalone, dependent], [
      { platform: 'github', projectKey: 'acme/base', code: 'issue_list_failed', message: 'HTTP 503', retryable: true },
    ]);
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => ({ workItemId, executionId: 'attempt', status: 'merge_ready' as const }));
    const { controller, wait } = schedulerStop();

    const result = await scheduleWorkItems({ parent: parent.id, signal: controller.signal }, {
      repositories: async subject => [subject.project.projectKey], load: () => 0, execute, wait,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ workItemId: standalone.id });
    expect(result.scope?.unreadable.map(diagnostic => diagnostic.projectKey)).toEqual(['acme/base']);
    expect(result.waiting.find(entry => entry.workItemId === dependent.id)?.waitReason).toBe('visibility_unknown');
  });

  it('escalates a broken project inside the range that cannot be retried', async () => {
    const { parent, standalone, dependent } = tree();
    platform.result = platformRead([parent, standalone, dependent], [
      { platform: 'github', projectKey: 'acme/base', code: 'project_not_found', message: '404 Project Not Found', retryable: false },
    ]);
    const execute = vi.fn(async ({ workItemId }: { workItemId: string }) => ({ workItemId, executionId: 'attempt', status: 'merge_ready' as const }));
    const { controller, wait } = schedulerStop();

    const result = await scheduleWorkItems({ parent: parent.id, signal: controller.signal }, {
      repositories: async subject => [subject.project.projectKey], load: () => 0, execute, wait,
    });

    expect(result.waiting.find(entry => entry.workItemId === dependent.id)?.waitReason).toBe('awaiting_human');
    expect(result.scope?.unreadable.map(diagnostic => diagnostic.code)).toEqual(['project_not_found']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ workItemId: standalone.id });
  });
});
