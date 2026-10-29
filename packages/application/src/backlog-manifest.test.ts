import { describe, expect, it } from 'vitest';
import {
  planBacklogManifest,
  type BacklogManifestItem,
  type BacklogManifestReference,
} from './index.js';

function item(overrides: Partial<BacklogManifestItem> = {}): BacklogManifestItem {
  return {
    title: 'Item',
    description: 'Body.',
    dependsOn: [],
    tags: [],
    ...overrides,
  };
}

describe('backlog manifest plan', () => {
  it('gives every item a target project', () => {
    const plan = planBacklogManifest({
      items: [
        item({ title: 'Publish the route map', project: 'gitlab:w.src.corp.qihoo.net/fang/services/k-base' }),
        item({ title: 'Resolve the endpoint', project: 'gitlab:w.src.corp.qihoo.net/fang/services/atlas#2' }),
      ],
    });
    expect(plan.entries.map(entry => entry.project)).toEqual([
      'gitlab:w.src.corp.qihoo.net/fang/services/k-base',
      'gitlab:w.src.corp.qihoo.net/fang/services/atlas#2',
    ]);
  });

  it('falls back to the default project for an item without one', () => {
    const plan = planBacklogManifest({ items: [item()] }, { defaultProject: 'github:org/repo' });
    expect(plan.entries[0]?.project).toBe('github:org/repo');
  });

  it('reports an item with no project at all', () => {
    expect(() => planBacklogManifest({ items: [item()] })).toThrow(/project/i);
  });

  it('rejects a project that names no platform', () => {
    expect(() => planBacklogManifest({ items: [item({ project: 'org/repo' })] })).toThrow(/project/i);
  });

  it('tells a global identity from a manifest-local reference', () => {
    const plan = planBacklogManifest({
      items: [
        item({
          title: 'Publish the route map',
          project: 'gitlab:w.src.corp.qihoo.net/fang/services/k-base',
          ref: 'route',
          parentId: 'gitlab:w.src.corp.qihoo.net/fang/services/aiapi#6',
        }),
        item({
          title: 'Resolve the endpoint',
          project: 'gitlab:w.src.corp.qihoo.net/fang/services/atlas#2',
          ref: 'endpoint',
          dependsOn: ['route'],
        }),
      ],
    });
    expect(plan.entries[0]?.parentId).toEqual<BacklogManifestReference>({
      kind: 'global',
      id: 'gitlab:w.src.corp.qihoo.net/fang/services/aiapi#6',
    });
    expect(plan.entries[1]?.dependsOn).toEqual<BacklogManifestReference[]>([
      { kind: 'local', ref: 'route' },
    ]);
  });

  it('rejects a reference to a ref no item declares', () => {
    expect(() => planBacklogManifest({
      items: [item({ project: 'github:org/repo', dependsOn: ['missing'] })],
    })).toThrow(/missing/);
  });

  it('rejects two items that declare the same ref', () => {
    expect(() => planBacklogManifest({
      items: [
        item({ title: 'One', project: 'github:org/repo', ref: 'same' }),
        item({ title: 'Two', project: 'github:org/repo', ref: 'same' }),
      ],
    })).toThrow(/ref/i);
  });

  it('creates a dependency before the item that waits for it', () => {
    const plan = planBacklogManifest({
      items: [
        item({ title: 'Provider', project: 'github:org/repo', ref: 'provider' }),
        item({ title: 'Waiter', project: 'github:org/repo', ref: 'waiter', dependsOn: ['provider'] }),
      ],
    });
    expect(plan.entries.map(entry => entry.item.ref)).toEqual(['provider', 'waiter']);
  });

  it('keeps the manifest order when nothing waits for anything', () => {
    const plan = planBacklogManifest({
      items: [
        item({ title: 'One', project: 'github:org/repo', ref: 'one' }),
        item({ title: 'Two', project: 'github:org/repo', ref: 'two' }),
      ],
    });
    expect(plan.entries.map(entry => entry.item.ref)).toEqual(['one', 'two']);
  });

  it('creates a parent before the item that points at it', () => {
    // The parent has to exist before the child is created: the child records
    // a link to it.
    const unordered = planBacklogManifest({
      items: [
        item({ title: 'Child', project: 'github:org/api', ref: 'child', parentId: 'anchor' }),
        item({ title: 'Anchor', project: 'github:org/req', ref: 'anchor' }),
      ],
    });
    expect(unordered.entries.map(entry => entry.item.ref)).toEqual(['anchor', 'child']);
  });

  it('creates an execution base before the item that starts from it', () => {
    const unordered = planBacklogManifest({
      items: [
        item({ title: 'Child', project: 'github:org/api', ref: 'child', baseBacklogId: 'base' }),
        item({ title: 'Base', project: 'github:org/api', ref: 'base' }),
      ],
    });
    expect(unordered.entries.map(entry => entry.item.ref)).toEqual(['base', 'child']);
  });

  it('rejects a cycle that runs through a parent edge', () => {
    expect(() => planBacklogManifest({
      items: [
        item({ title: 'One', project: 'github:org/repo', ref: 'one', parentId: 'two' }),
        item({ title: 'Two', project: 'github:org/repo', ref: 'two', parentId: 'one' }),
      ],
    })).toThrow(/cycle/i);
  });

  it('rejects a dependency cycle', () => {
    expect(() => planBacklogManifest({
      items: [
        item({ title: 'One', project: 'github:org/repo', ref: 'one', dependsOn: ['two'] }),
        item({ title: 'Two', project: 'github:org/repo', ref: 'two', dependsOn: ['one'] }),
      ],
    })).toThrow(/cycle/i);
  });

  it('derives one idempotency key per item from the prefix', () => {
    const plan = planBacklogManifest({
      items: [
        item({ title: 'One', project: 'github:org/repo', ref: 'one' }),
        item({ title: 'Two', project: 'github:org/repo', ref: 'two' }),
      ],
    }, { idempotencyKeyPrefix: 'slices/2026-10-29' });
    expect(plan.entries.map(entry => entry.idempotencyKey)).toEqual([
      'slices/2026-10-29/one',
      'slices/2026-10-29/two',
    ]);
  });

  it('names an item by its title when it declares no ref', () => {
    const plan = planBacklogManifest({
      items: [item({ title: 'Only item', project: 'github:org/repo' })],
    }, { idempotencyKeyPrefix: 'batch' });
    expect(plan.entries[0]?.idempotencyKey).toBe('batch/Only item');
  });

  it('leaves the idempotency key unset when no prefix is given', () => {
    const plan = planBacklogManifest({ items: [item({ project: 'github:org/repo' })] });
    expect(plan.entries[0]?.idempotencyKey).toBeUndefined();
  });

  it('rejects an execution base that lives in another project', () => {
    expect(() => planBacklogManifest({
      items: [item({ project: 'github:org/api', baseBacklogId: 'github:org/web#3' })],
    })).toThrow(/execution base/i);
  });

  it('accepts an execution base that lives in the same project', () => {
    const plan = planBacklogManifest({
      items: [item({ project: 'github:org/api', baseBacklogId: 'github:org/api#3' })],
    });
    expect(plan.entries[0]?.baseBacklogId).toEqual<BacklogManifestReference>({
      kind: 'global',
      id: 'github:org/api#3',
    });
  });

  it('rejects an execution base that names an item in another project', () => {
    expect(() => planBacklogManifest({
      items: [
        item({ title: 'Base', project: 'github:org/web', ref: 'base' }),
        item({ title: 'Child', project: 'github:org/api', baseBacklogId: 'base' }),
      ],
    })).toThrow(/execution base/i);
  });
});
