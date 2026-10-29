import { describe, expect, it, vi } from 'vitest';
import type { BacklogCreateInput, BacklogItem, BacklogManagementProvider } from '../../domain/backlog/index';
import { planBacklogManifest, type BacklogManifest } from '@afk/application';
import { applyBacklogManifest, parseBacklogManifest } from './apply-manifest.js';

interface Recorded {
  project: string;
  input: BacklogCreateInput;
}

function provider(items: Recorded[], project: string): BacklogManagementProvider {
  return {
    async get() { throw new Error('not used'); },
    async list() { return []; },
    async planCreate() { throw new Error('not used'); },
    async create(input: BacklogCreateInput): Promise<BacklogItem> {
      items.push({ project, input });
      const id = `${project}#${items.length}`;
      return {
        id,
        issueNumber: items.length,
        title: input.title,
        description: input.description,
        dependsOn: [...(input.dependsOn ?? [])],
        state: 'ready',
        executionMode: input.executionMode ?? 'afk',
        tags: [...(input.tags ?? [])],
        branchName: `feature/${items.length}`,
        providerRef: id,
        webUrl: `https://example.test/${id}`,
      };
    },
    async addTag() { /* noop */ },
    async removeTag() { /* noop */ },
    async initialize() { /* noop */ },
  } as unknown as BacklogManagementProvider;
}

describe('backlog manifest parsing', () => {
  it('reads the provider-neutral item contract', () => {
    const manifest = parseBacklogManifest(`
- title: Publish the route map
  description: Publish the enterprise route mapping.
  project: gitlab:w.src.corp.qihoo.net/fang/services/k-base
  ref: kbase-route
  parentId: gitlab:w.src.corp.qihoo.net/fang/services/aiapi#6
  dependsOn: [gitlab:w.src.corp.qihoo.net/fang/services/atlas#2]
  executionMode: afk
  tags: [backend]
- title: Resolve the endpoint
  description: Resolve the private endpoint.
  project: gitlab:w.src.corp.qihoo.net/fang/services/atlas#2
`);

    expect(manifest.items).toHaveLength(2);
    expect(manifest.items[0]).toMatchObject({
      title: 'Publish the route map',
      project: 'gitlab:w.src.corp.qihoo.net/fang/services/k-base',
      ref: 'kbase-route',
      parentId: 'gitlab:w.src.corp.qihoo.net/fang/services/aiapi#6',
      dependsOn: ['gitlab:w.src.corp.qihoo.net/fang/services/atlas#2'],
      executionMode: 'afk',
      tags: ['backend'],
    });
    expect(manifest.items[1]).toMatchObject({ title: 'Resolve the endpoint', dependsOn: [], tags: [] });
  });

  it('rejects an item without a title or description', () => {
    expect(() => parseBacklogManifest('- title: ""\n  description: Body')).toThrow(/title/i);
    expect(() => parseBacklogManifest('- title: Item\n  description: ""')).toThrow(/description/i);
  });

  it('rejects an item that names an unknown execution mode', () => {
    expect(() => parseBacklogManifest('- title: Item\n  description: Body\n  executionMode: auto')).toThrow(/executionMode/i);
  });

  it('rejects a document that is not a list of items', () => {
    expect(() => parseBacklogManifest('title: Item')).toThrow(/item/i);
  });
});

describe('backlog manifest application', () => {
  it('creates every item in the project it names', async () => {
    const created: Recorded[] = [];
    const providers = new Map<string, BacklogManagementProvider>();
    const manifest: BacklogManifest = {
      items: [
        { title: 'One', description: 'Body.', project: 'github:org/api', dependsOn: [], tags: [] },
        { title: 'Two', description: 'Body.', project: 'github:org/web', dependsOn: [], tags: [] },
      ],
    };

    const result = await applyBacklogManifest(planBacklogManifest(manifest), async (project) => {
      if (!providers.has(project)) providers.set(project, provider(created, project));
      return providers.get(project)!;
    });

    expect(created.map(entry => [entry.project, entry.input.title])).toEqual([
      ['github:org/api', 'One'],
      ['github:org/web', 'Two'],
    ]);
    expect(result.records.map(record => record.id)).toEqual(['github:org/api#1', 'github:org/web#2']);
  });

  it('resolves a manifest-local parent to the record it created', async () => {
    const created: Recorded[] = [];
    const manifest: BacklogManifest = {
      items: [
        { title: 'Child', description: 'Body.', project: 'github:org/api', ref: 'child', parentId: 'anchor', dependsOn: [], tags: [] },
        { title: 'Anchor', description: 'Body.', project: 'github:org/req', ref: 'anchor', dependsOn: [], tags: [] },
      ],
    };

    await applyBacklogManifest(planBacklogManifest(manifest), async (project) => provider(created, project));

    // The parent is created first, because the child records a link to it.
    expect(created[0]?.input.title).toBe('Anchor');
    expect(created[1]?.input.parentId).toBe('github:org/req#1');
  });

  it('resolves a manifest-local dependency to the record it created', async () => {
    const created: Recorded[] = [];
    const manifest: BacklogManifest = {
      items: [
        { title: 'Waiter', description: 'Body.', project: 'github:org/api', ref: 'waiter', dependsOn: ['provider'], tags: [] },
        { title: 'Provider', description: 'Body.', project: 'github:org/lib', ref: 'provider', dependsOn: [], tags: [] },
      ],
    };

    await applyBacklogManifest(planBacklogManifest(manifest), async (project) => provider(created, project));

    expect(created[0]?.input.title).toBe('Provider');
    expect(created[1]?.input.dependsOn).toEqual(['github:org/lib#1']);
  });

  it('keeps a global identity as it is', async () => {
    const created: Recorded[] = [];
    const manifest: BacklogManifest = {
      items: [
        {
          title: 'Child', description: 'Body.', project: 'github:org/api', dependsOn: [],
          parentId: 'github:org/req#7', tags: [],
        },
      ],
    };

    await applyBacklogManifest(planBacklogManifest(manifest), async (project) => provider(created, project));

    expect(created[0]?.input.parentId).toBe('github:org/req#7');
  });

  it('passes the retry key to the provider', async () => {
    const created: Recorded[] = [];
    const manifest: BacklogManifest = {
      items: [
        { title: 'One', description: 'Body.', project: 'github:org/api', ref: 'one', dependsOn: [], tags: [] },
      ],
    };

    await applyBacklogManifest(
      planBacklogManifest(manifest, { idempotencyKeyPrefix: 'batch' }),
      async (project) => provider(created, project),
    );

    expect(created[0]?.input.idempotencyKey).toBe('batch/one');
  });

  it('asks for one provider per project', async () => {
    const created: Recorded[] = [];
    const ask = vi.fn(async (project: string) => provider(created, project));
    const manifest: BacklogManifest = {
      items: [
        { title: 'One', description: 'Body.', project: 'github:org/api', dependsOn: [], tags: [] },
        { title: 'Two', description: 'Body.', project: 'github:org/api', dependsOn: [], tags: [] },
      ],
    };

    await applyBacklogManifest(planBacklogManifest(manifest), ask);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('github:org/api');
  });

  it('carries the business tags and the execution mode', async () => {
    const created: Recorded[] = [];
    const manifest: BacklogManifest = {
      items: [
        { title: 'One', description: 'Body.', project: 'github:org/api', executionMode: 'hitl', tags: ['backend'], dependsOn: [], },
      ],
    };

    await applyBacklogManifest(planBacklogManifest(manifest), async (project) => provider(created, project));

    expect(created[0]?.input.executionMode).toBe('hitl');
    expect(created[0]?.input.tags).toEqual(['backend']);
  });
});
