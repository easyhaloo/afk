import { BacklogServiceError } from "./backlog-error";
import type {
  BacklogCreateInput,
  BacklogItem,
  BacklogListOptions,
  BacklogPlatform,
} from "../../shared/backlog-contract";

export const BACKLOG_LIST_DEFAULT_TTL_MS = 30_000;
export const BACKLOG_DEFAULT_TIMEOUT_MS = 30_000;

export type BacklogExecResult = { ok: boolean; stdout: string; stderr: string };

export type BacklogExecFn = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<BacklogExecResult>;

export type BacklogServiceDeps = {
  /** Resolve the absolute path of the `afk` CLI binary, or empty string if missing. */
  resolveAfk: () => Promise<string>;
  /** Resolve a workspace path to an absolute filesystem path. */
  resolveWorkspace: (input: string) => string;
  /** Subprocess executor (defaults to the Electron adapter's `exec`). */
  exec?: BacklogExecFn;
};

export type BacklogServiceOptions = {
  ttlMs?: number;
  timeoutMs?: number;
};

type CacheEntry = { value: BacklogItem[]; expiresAt: number };

type JsonSuccess<T> = { ok: true; kind: string; data: T };
type JsonFailure = { ok: false; kind: string; error: { code: BacklogItem["state"] | string; message: string; details?: Record<string, unknown> } };
type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

const PLATFORMS = new Set<BacklogPlatform>(["github", "gitlab"]);

function asPlatform(value: unknown): BacklogPlatform | undefined {
  return typeof value === "string" && PLATFORMS.has(value as BacklogPlatform) ? (value as BacklogPlatform) : undefined;
}

export function createBacklogService(deps: BacklogServiceDeps, options: BacklogServiceOptions = {}) {
  const exec = deps.exec ?? (async () => ({ ok: false, stdout: "", stderr: "no executor configured" }));
  const ttlMs = options.ttlMs ?? BACKLOG_LIST_DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? BACKLOG_DEFAULT_TIMEOUT_MS;
  const listCache = new Map<string, CacheEntry>();
  let cacheGeneration = 0;

  function listCacheKey(workspace: string, platform: BacklogPlatform | undefined, options?: BacklogListOptions): string {
    return JSON.stringify([workspace, platform ?? "auto", options ? { ...options } : {}]);
  }

  function invalidateListCache(): void {
    cacheGeneration += 1;
    listCache.clear();
  }

  async function runJson<T>(args: string[], workspace: string, kind: string): Promise<T> {
    const afkPath = await deps.resolveAfk();
    if (!afkPath) {
      throw new BacklogServiceError("auth", "afk CLI 未在 PATH 中发现；请安装或设置 PATH", {
        hint: "afk CLI must be installed and on PATH for backlog features",
      });
    }
    const cwd = deps.resolveWorkspace(workspace);
    const result = await runWithTimeout(afkPath, [...args, "--json"], cwd, timeoutMs);
    if (!result.ok && !result.stdout) {
      // Subprocess died before emitting JSON — likely spawn / timeout / signal.
      throw new BacklogServiceError("unknown", result.stderr || "afk 子进程退出但未输出 JSON");
    }
    let envelope: JsonEnvelope<T>;
    try {
      envelope = JSON.parse(result.stdout) as JsonEnvelope<T>;
    } catch (cause) {
      throw new BacklogServiceError("unknown", `afk 返回的不是合法 JSON：${result.stdout.slice(0, 200)}`);
    }
    if (!envelope.ok) {
      const code = (envelope.error.code ?? "unknown") as BacklogItem["state"] extends infer _ ? string : string;
      throw new BacklogServiceError(
        code === "auth" || code === "not_found" || code === "validation" || code === "provider" ? code : "unknown",
        envelope.error.message,
        envelope.error.details,
      );
    }
    return envelope.data;
  }

  async function runWithTimeout(cmd: string, args: string[], cwd: string, ms: number): Promise<BacklogExecResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exec(cmd, args, cwd),
        new Promise<BacklogExecResult>((_, reject) => {
          timer = setTimeout(() => reject(new BacklogServiceError("unknown", `afk 子进程超时（${ms}ms）`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function buildListArgs(options?: BacklogListOptions): string[] {
    const args = ["backlog", "list"];
    if (options?.state) { args.push("--state", options.state); }
    if (options?.executionMode) { args.push("--mode", options.executionMode); }
    if (options?.parentId) { args.push("--parent", options.parentId); }
    if (options?.tag) { args.push("--tag", options.tag); }
    const platform = options?.platform;
    if (platform) { args.push("--platform", platform); }
    return args;
  }

  function buildCreateArgs(input: BacklogCreateInput): string[] {
    const args = ["backlog", "create", input.title, "--description-file", "/dev/stdin"];
    if (input.parentId) args.push("--parent", input.parentId);
    if (input.baseBacklogId) args.push("--base-backlog", input.baseBacklogId);
    if (input.dependsOn) for (const dep of input.dependsOn) args.push("--depends-on", dep);
    if (input.executionMode) args.push("--mode", input.executionMode);
    if (input.tags) for (const tag of input.tags) args.push("--tag", tag);
    if (input.platform) args.push("--platform", input.platform);
    return args;
  }

  return {
    async list(workspace: string, options?: BacklogListOptions): Promise<BacklogItem[]> {
      const platform = asPlatform(options?.platform);
      const key = listCacheKey(workspace, platform, options);
      const cached = listCache.get(key);
      const generation = cacheGeneration;
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const data = await runJson<BacklogItem[]>(buildListArgs(options), workspace, "backlog.list");
      if (generation === cacheGeneration) listCache.set(key, { value: data, expiresAt: Date.now() + ttlMs });
      return data;
    },

    async show(workspace: string, id: string): Promise<BacklogItem> {
      if (!id) throw new BacklogServiceError("validation", "backlog id is required");
      const platform = asPlatform(undefined);
      return runJson<BacklogItem>(
        ["backlog", "show", "--id", id, ...(platform ? ["--platform", platform] : [])],
        workspace,
        "backlog.show",
      );
    },

    async create(workspace: string, input: BacklogCreateInput): Promise<BacklogItem> {
      if (!input.title?.trim()) throw new BacklogServiceError("validation", "backlog title is required");
      if (!input.description?.trim()) throw new BacklogServiceError("validation", "backlog description is required");
      const item = await runJson<BacklogItem>(buildCreateArgs(input), workspace, "backlog.create");
      invalidateListCache();
      return item;
    },

    async addTag(workspace: string, id: string, tag: string): Promise<BacklogItem> {
      if (!id) throw new BacklogServiceError("validation", "backlog id is required");
      if (!tag) throw new BacklogServiceError("validation", "tag is required");
      const item = await runJson<BacklogItem>(["backlog", "tag", "add", "--id", id, "--tag", tag], workspace, "backlog.tag.add");
      invalidateListCache();
      return item;
    },

    async removeTag(workspace: string, id: string, tag: string): Promise<BacklogItem> {
      if (!id) throw new BacklogServiceError("validation", "backlog id is required");
      if (!tag) throw new BacklogServiceError("validation", "tag is required");
      const item = await runJson<BacklogItem>(["backlog", "tag", "remove", "--id", id, "--tag", tag], workspace, "backlog.tag.remove");
      invalidateListCache();
      return item;
    },

    /** Test/debug helper: clear the in-memory list cache. */
    invalidateListCache,
  };
}
