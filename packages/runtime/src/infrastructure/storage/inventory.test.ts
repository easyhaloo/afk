import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InventoryItem, InventoryScope, InventorySnapshot } from '@afk/application';
import { SqliteInventoryStore } from './inventory.js';

const roots: string[] = [];
const stores: SqliteInventoryStore[] = [];
const scope: InventoryScope = { platform: 'github', host: 'github.com', kind: 'catalog' };
const project = { platform: 'github' as const, projectKey: 'acme/api', name: 'API', defaultBranch: 'main' };
function open(root = mkdtempSync(join(tmpdir(), 'afk-inventory-'))) {
  if (!roots.includes(root)) roots.push(root);
  const store = new SqliteInventoryStore({ root, namespaceKey: 'a'.repeat(64) });
  stores.push(store);
  return store;
}
function item(number = 1, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return { id: `github:acme/api#${number}`, issueNumber: number, project, title: `仓库任务 ${number}`, managed: true,
    executionEligible: true, state: 'ready', executionMode: 'afk', dependsOn: [], tags: [], branchName: `feature/${number}`,
    providerRef: `github:acme/api#${number}`, ...overrides };
}
function snapshot(items: InventoryItem[], complete = true): InventorySnapshot {
  return { items, projects: [project], diagnostics: [], complete };
}
async function publish(store: SqliteInventoryStore, items: InventoryItem[], complete = true) {
  return store.publish(await store.begin(scope), snapshot(items, complete));
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('normalized inventory', () => {
  it('round trips every relationship and optional array with original identities', async () => {
    const store = open();
    const full = item(1, {
      description: 'description', parentId: 'github:acme/other#99', dependsOn: ['github:acme/other#98'], tags: ['第二', 'first', '第二'],
      sources: [{ id: 'original-source', type: 'external', title: '来源', reference: 'external', role: 'request' }],
      repositories: [{ ...project, id: 'original-association', checkoutPath: 'api', baseBranch: 'develop', role: 'primary' }],
      executionPlan: [{ id: 'original-step', title: 'step', detail: 'detail', status: 'pending' }],
      runs: [{ id: 'original-run', status: 'completed', startedAt: '2026-10-22T00:00:00.000Z', completedAt: '2026-10-22T01:00:00.000Z',
        workflow: 'default', workingBranch: 'feature/1', repositories: [{ platform: 'github', projectKey: 'acme/api', name: 'API', checkoutPath: 'api', baseBranch: 'main' }], workspacePath: '/workspace', pid: 123 }],
      owner: 'operator', priority: 'P1', updatedAt: '2026-10-22T00:00:00.000Z',
    });
    await publish(store, [full, item(2, { sources: [], repositories: [], executionPlan: [], runs: [] }), item(3)]);
    expect(await store.get(full.id)).toEqual(full);
    expect(await open(roots[0]).get(full.id)).toEqual(full);
    expect(await store.get('github:acme/api#2')).toEqual(item(2, { sources: [], repositories: [], executionPlan: [], runs: [] }));
    expect(await store.get('github:acme/api#3')).toEqual(item(3));
    expect(await store.titles([full.id, 'github:acme/missing#9'])).toEqual([{ id: full.id, title: full.title }, { id: 'github:acme/missing#9' }]);
  });

  it('filters in SQL and treats Chinese, short text and FTS punctuation literally', async () => {
    const store = open();
    await publish(store, [item(1, { title: '中文搜索 "P0":_100%', tags: ['bug'] }), item(2, { state: 'done', executionEligible: false }),
      item(3, { sources: [{ id: 'gl', type: 'gitlab_issue', title: '外部', reference: 'gl', platform: 'gitlab' }] }), item(4, { sources: [] })]);
    for (const text of ['中文搜', '"P0"', ':_100%', '中文']) {
      expect((await store.query({ text })).items.map(entry => entry.id), text).toEqual(['github:acme/api#1']);
    }
    expect((await store.query({ state: 'done' })).items.map(entry => entry.id)).toEqual(['github:acme/api#2']);
    expect((await store.query({ tag: 'bug', platform: 'github' })).items.map(entry => entry.id)).toEqual(['github:acme/api#1']);
    expect((await store.query({ platform: 'gitlab' })).items.map(entry => entry.id)).toEqual(['github:acme/api#3']);
    expect((await store.query({ platform: 'github' })).items.map(entry => entry.id)).toEqual(['github:acme/api#1', 'github:acme/api#2']);
    expect((await store.repositories({ text: 'acme' })).items).toEqual([project]);
  });

  it('uses stable bounded cursors and rejects changed revisions or filters', async () => {
    const store = open();
    await publish(store, [item(1), item(2), item(3)]);
    const first = await store.query({ limit: 2 });
    expect(first.items.map(entry => entry.id)).toEqual(['github:acme/api#1', 'github:acme/api#2']);
    expect((await store.query({ limit: 2, cursor: first.nextCursor })).items.map(entry => entry.id)).toEqual(['github:acme/api#3']);
    await expect(store.query({ state: 'done', cursor: first.nextCursor })).rejects.toThrow(/cursor/i);
    await publish(store, [item(1), item(2), item(3), item(4)]);
    await expect(store.query({ cursor: first.nextCursor })).rejects.toThrow(/CURSOR_EXPIRED/);
    await expect(store.query({ limit: 201 })).rejects.toThrow(/limit/i);
    await expect(store.query({ cursor: 'invalid' })).rejects.toThrow(/cursor/i);
  });

  it('preserves old rows on partial/failure, hides only complete scope absences and discards stale attempts', async () => {
    const store = open();
    await publish(store, [item(1), item(2)]);
    await publish(store, [item(1, { title: 'partial' })], false);
    expect((await store.query()).items).toHaveLength(2);
    expect((await store.query()).complete).toBe(false);
    const old = await store.begin(scope);
    const current = await store.begin(scope);
    expect(await store.publish(old, snapshot([]))).toBe(false);
    expect(await store.fail(old, { platform: 'github', code: 'old', message: 'old', retryable: true })).toBe(false);
    expect(await store.publish(current, snapshot([item(2)]))).toBe(true);
    expect((await store.query()).items.map(entry => entry.id)).toEqual(['github:acme/api#2']);
    expect(await store.get('github:acme/api#1')).toBeDefined();
    await store.fail(await store.begin(scope), { platform: 'github', code: 'offline', message: 'offline', retryable: true });
    expect((await store.query()).items).toHaveLength(1);
    expect((await store.query()).diagnostics[0].code).toBe('offline');
  });

  it('rolls back all changes when a later item is invalid', async () => {
    const store = open();
    await publish(store, [item(1)]);
    await expect(publish(store, [item(1, { title: 'changed' }), item(2, { title: '' })])).rejects.toThrow();
    expect((await store.get('github:acme/api#1'))?.title).toBe('仓库任务 1');
    expect(await store.get('github:acme/api#2')).toBeUndefined();
    await expect(publish(store, [item(1, { id: 'github:other/repo#1' })])).rejects.toThrow(/identity/i);
  });
});
