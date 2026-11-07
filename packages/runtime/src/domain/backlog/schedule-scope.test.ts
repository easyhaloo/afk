import { describe, expect, it } from 'vitest';
import { assessScheduleScope, computeScheduleScope, workItemProjectKey } from './schedule-scope.js';
import { parseWorkItemId } from '../work-item/identity.js';
import type { GlobalWorkItem } from '../work-item/types.js';
import type { InventoryDiagnostic } from '../work-item/provider-types.js';

function item(project: string, number: number, overrides: Partial<GlobalWorkItem> = {}): GlobalWorkItem {
  const id = parseWorkItemId(`github:${project}#${number}`).id;
  return { id, issueNumber: number, project: { platform: 'github', projectKey: project, name: project },
    title: id, managed: true, executionEligible: true, state: 'ready', executionMode: 'afk',
    dependsOn: [], tags: [], branchName: `afk/${number}`, providerRef: id, ...overrides };
}

function diagnostic(projectKey: string, overrides: Partial<InventoryDiagnostic> = {}): InventoryDiagnostic {
  return { platform: 'github', projectKey, code: 'issue_list_failed', message: 'HTTP 503', retryable: true, ...overrides };
}

describe('computeScheduleScope', () => {
  it('covers the parent, its slices, and what those slices wait for', () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const grandchild = item('acme/web', 3, { parentId: child.id });
    const dependency = item('acme/base', 4);

    const scope = computeScheduleScope(
      [parent, child, grandchild, { ...child, dependsOn: [dependency.id] }],
      parent.id,
    );

    expect([...scope.items].sort()).toEqual([parent.id, child.id, grandchild.id, dependency.id].sort());
    expect([...scope.projects].sort()).toEqual(['acme/api', 'acme/base', 'acme/prd', 'acme/web'].sort());
  });

  it('counts a dependency whose item could not be read, because its identity names the project', () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id, dependsOn: ['github:acme/secret#9'] });

    const scope = computeScheduleScope([parent, child], parent.id);

    // The item was not read, so nothing is known about it — but the scope
    // knows the project it lives in, and that project matters.
    expect(scope.items.has('github:acme/secret#9')).toBe(true);
    expect(scope.projects.has('acme/secret')).toBe(true);
  });

  it('keeps an unrelated project out of the scope', () => {
    const parent = item('acme/prd', 1, { kind: 'prd' });
    const child = item('acme/api', 2, { parentId: parent.id });
    const stranger = item('other/repo', 3);

    const scope = computeScheduleScope([parent, child, stranger], parent.id);

    expect(scope.projects.has('other/repo')).toBe(false);
    expect(scope.items.has(stranger.id)).toBe(false);
  });
});

describe('assessScheduleScope', () => {
  const parent = item('acme/prd', 1, { kind: 'prd' });
  const child = item('acme/api', 2, { parentId: parent.id, dependsOn: ['github:acme/base#3'] });
  const scope = computeScheduleScope([parent, child], parent.id);

  it('holds a diagnostic about a project the scope depends on', () => {
    const assessment = assessScheduleScope(scope, [diagnostic('acme/base')]);

    expect(assessment.blocking.map(entry => entry.projectKey)).toEqual(['acme/base']);
    expect(assessment.reported).toEqual([]);
  });

  it('reports a diagnostic about a project outside the scope without holding it', () => {
    const assessment = assessScheduleScope(scope, [diagnostic('other/repo')]);

    expect(assessment.blocking).toEqual([]);
    expect(assessment.reported.map(entry => entry.projectKey)).toEqual(['other/repo']);
  });

  it('holds a project list failure, because the candidates could not be enumerated', () => {
    const assessment = assessScheduleScope(scope, [
      diagnostic('github.com', { code: 'project_list_failed', message: 'HTTP 500' }),
    ]);

    expect(assessment.blocking.map(entry => entry.code)).toEqual(['project_list_failed']);
    expect(assessment.reported).toEqual([]);
  });
});

describe('workItemProjectKey', () => {
  it('reads the project out of a canonical identity', () => {
    expect(workItemProjectKey('github:acme/api#2')).toBe('acme/api');
  });

  it('says nothing about an identity that is not canonical', () => {
    expect(workItemProjectKey('not-an-identity')).toBeUndefined();
  });
});
