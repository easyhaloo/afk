import {
  addBacklogTag,
  classifyError,
  createBacklog,
  listBacklogs,
  removeBacklogTag,
  showBacklog,
  type BacklogManagementProvider,
} from "@afk/application";
import { BacklogServiceError } from "./backlog-error.js";
import type {
  BacklogCreateInput,
  BacklogItem,
  BacklogListOptions,
  BacklogPlatform,
} from "../../shared/backlog-contract.js";

export const BACKLOG_LIST_DEFAULT_TTL_MS = 30_000;

export type BacklogServiceDeps = {
  /**
   * Resolve the backlog provider for a workspace. The provider is the
   * `@afk/application` Port, so the desktop talks to the same use cases the
   * CLI does instead of a CLI subprocess.
   */
  providers: (workspace: string, platform?: BacklogPlatform) => Promise<BacklogManagementProvider>;
  /** Resolve a workspace path to an absolute filesystem path. */
  resolveWorkspace: (input: string) => string;
};

export type BacklogServiceOptions = {
  ttlMs?: number;
};

type CacheEntry = { value: BacklogItem[]; expiresAt: number };

const PLATFORMS = new Set<BacklogPlatform>(["github", "gitlab"]);

function asPlatform(value: unknown): BacklogPlatform | undefined {
  return typeof value === "string" && PLATFORMS.has(value as BacklogPlatform) ? (value as BacklogPlatform) : undefined;
}

export function createBacklogService(deps: BacklogServiceDeps, options: BacklogServiceOptions = {}) {
  const ttlMs = options.ttlMs ?? BACKLOG_LIST_DEFAULT_TTL_MS;
  const listCache = new Map<string, CacheEntry>();
  let cacheGeneration = 0;

  function listCacheKey(workspace: string, platform: BacklogPlatform | undefined, options?: BacklogListOptions): string {
    return JSON.stringify([workspace, platform ?? "auto", options ? { ...options } : {}]);
  }

  function invalidateListCache(): void {
    cacheGeneration += 1;
    listCache.clear();
  }

  /**
   * Run one backlog use case against the workspace provider, translating a
   * thrown error into the structured code the renderer renders.
   */
  async function run<T>(workspace: string, platform: BacklogPlatform | undefined, action: (provider: BacklogManagementProvider) => Promise<T>): Promise<T> {
    const provider = await deps.providers(deps.resolveWorkspace(workspace), platform);
    try {
      return await action(provider);
    } catch (error) {
      const code = classifyError(error);
      throw new BacklogServiceError(
        code === "auth" || code === "not_found" || code === "validation" || code === "provider" ? code : "unknown",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    async list(workspace: string, options?: BacklogListOptions): Promise<BacklogItem[]> {
      const platform = asPlatform(options?.platform);
      const key = listCacheKey(workspace, platform, options);
      const cached = listCache.get(key);
      const generation = cacheGeneration;
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const data = await run(workspace, platform, provider => listBacklogs(provider, {
        ...(options?.state ? { state: options.state } : {}),
        ...(options?.executionMode ? { executionMode: options.executionMode } : {}),
        ...(options?.parentId ? { parentId: options.parentId } : {}),
        ...(options?.tag ? { tag: options.tag } : {}),
      }));
      if (generation === cacheGeneration) listCache.set(key, { value: data, expiresAt: Date.now() + ttlMs });
      return data;
    },

    async show(workspace: string, id: string): Promise<BacklogItem> {
      if (!id) throw new BacklogServiceError("validation", "backlog id is required");
      return run(workspace, undefined, provider => showBacklog(provider, id));
    },

    async create(workspace: string, input: BacklogCreateInput): Promise<BacklogItem> {
      if (!input.title?.trim()) throw new BacklogServiceError("validation", "backlog title is required");
      if (!input.description?.trim()) throw new BacklogServiceError("validation", "backlog description is required");
      const item = await run(workspace, asPlatform(input.platform), provider => createBacklog(provider, {
        title: input.title,
        description: input.description,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.baseBacklogId ? { baseBacklogId: input.baseBacklogId } : {}),
        ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
        ...(input.executionMode ? { executionMode: input.executionMode } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      }));
      invalidateListCache();
      return item;
    },

    async addTag(workspace: string, id: string, tag: string): Promise<BacklogItem> {
      if (!id) throw new BacklogServiceError("validation", "backlog id is required");
      if (!tag) throw new BacklogServiceError("validation", "tag is required");
      const item = await run(workspace, undefined, async provider => {
        await addBacklogTag(provider, id, tag);
        return showBacklog(provider, id);
      });
      invalidateListCache();
      return item;
    },

    async removeTag(workspace: string, id: string, tag: string): Promise<BacklogItem> {
      if (!id) throw new BacklogServiceError("validation", "backlog id is required");
      if (!tag) throw new BacklogServiceError("validation", "tag is required");
      const item = await run(workspace, undefined, async provider => {
        await removeBacklogTag(provider, id, tag);
        return showBacklog(provider, id);
      });
      invalidateListCache();
      return item;
    },

    /** Test/debug helper: clear the in-memory list cache. */
    invalidateListCache,
  };
}
