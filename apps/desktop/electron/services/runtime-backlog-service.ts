import { createBacklogRuntime, type BacklogRuntime } from '@afk/runtime/backlog';
import { classifyError } from '@afk/runtime/errors';
import { parseBacklogItem, type BacklogItem, type BacklogListOptions, type BacklogCreateInput } from '../../shared/backlog-contract.js';
import { BacklogServiceError } from './backlog-error.js';

export function createRuntimeBacklogService(
  resolveWorkspace: (workspace: string) => string,
  runtime: BacklogRuntime = createBacklogRuntime(),
  ttlMs = 30_000,
) {
  const cache = new Map<string, { expiresAt: number; items: BacklogItem[] }>();
  let generation = 0;
  const invalidateListCache = () => { generation++; cache.clear(); };
  const item = (value: unknown) => parseBacklogItem(value);
  const invoke = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof BacklogServiceError) throw error;
      throw new BacklogServiceError(classifyError(error), error instanceof Error ? error.message : String(error));
    }
  };
  const mutate = async (operation: () => Promise<unknown>) => {
    const result = item(await invoke(operation));
    invalidateListCache();
    return result;
  };
  return {
    async list(workspace: string, options: BacklogListOptions = {}) {
      const root = resolveWorkspace(workspace);
      const key = JSON.stringify([root, options.platform, options.state, options.executionMode, options.parentId, options.tag]);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.items;
      const started = generation;
      const items = (await invoke(() => runtime.list(root, options))).map(item);
      if (generation === started) cache.set(key, { items, expiresAt: Date.now() + ttlMs });
      return items;
    },
    async show(workspace: string, id: string) { return item(await invoke(() => runtime.show(resolveWorkspace(workspace), id))); },
    async create(workspace: string, input: BacklogCreateInput) { return mutate(() => runtime.create(resolveWorkspace(workspace), input)); },
    async addTag(workspace: string, id: string, tag: string) { return mutate(() => runtime.addTag(resolveWorkspace(workspace), id, tag)); },
    async removeTag(workspace: string, id: string, tag: string) { return mutate(() => runtime.removeTag(resolveWorkspace(workspace), id, tag)); },
    async interrupt(workspace: string, id: string, reason: string) { return mutate(() => runtime.interrupt(resolveWorkspace(workspace), id, reason)); },
    async confirmMerge(workspace: string, id: string) { return mutate(() => runtime.confirmMerge(resolveWorkspace(workspace), id)); },
    invalidateListCache,
  };
}
