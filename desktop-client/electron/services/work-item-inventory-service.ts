import { BacklogServiceError } from "./backlog-error";
import {
  parseWorkItemInventoryOptions,
  parseWorkItemInventoryResult,
  type WorkItemInventoryOptions,
  type WorkItemInventoryResult,
} from "../../shared/backlog-contract";
import { workItemInventoryKey, type WorkItemInventoryStore } from "./work-item-inventory-store";

export type AfkInvocation = { command: string; args: string[] };
export type WorkItemInventoryExecResult = { ok: boolean; stdout: string; stderr: string };

export type WorkItemInventoryServiceDeps = {
  resolveAfk: () => Promise<AfkInvocation>;
  cwd: string;
  exec: (command: string, args: string[], cwd: string) => Promise<WorkItemInventoryExecResult>;
  store?: WorkItemInventoryStore;
  staleAfterMs?: number;
};

type JsonEnvelope =
  | { ok: true; kind: "backlog.inventory"; data: unknown }
  | { ok: false; kind: "backlog.inventory"; error: { code: string; message: string; details?: Record<string, unknown> } };

function parseEnvelope(raw: string): JsonEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BacklogServiceError("provider", `afk 返回的 inventory 不是合法 JSON：${raw.slice(0, 200)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BacklogServiceError("provider", "afk 返回了无效的 backlog.inventory envelope");
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== "backlog.inventory" || typeof envelope.ok !== "boolean") throw new BacklogServiceError("provider", "afk 返回了错误的 inventory kind");
  return envelope as unknown as JsonEnvelope;
}

function inventoryArgs(options: WorkItemInventoryOptions): string[] {
  const args = ["backlog", "inventory"];
  if (options.platform) args.push("--platform", options.platform);
  if (options.state) args.push("--state", options.state);
  if (options.executionMode) args.push("--mode", options.executionMode);
  if (options.tag) args.push("--tag", options.tag);
  if (options.project) args.push("--project", options.project);
  args.push("--json");
  return args;
}

export function createWorkItemInventoryService(deps: WorkItemInventoryServiceDeps) {
  const cache = new Map<string, WorkItemInventoryResult>();
  const syncedAt = new Map<string, number>();
  const refreshes = new Map<string, Promise<WorkItemInventoryResult>>();
  const staleAfterMs = deps.staleAfterMs ?? 5 * 60 * 1000;

  return {
    async list(rawOptions?: WorkItemInventoryOptions, force = false): Promise<WorkItemInventoryResult> {
      const options = parseWorkItemInventoryOptions(rawOptions);
      const key = workItemInventoryKey(options);
      if (force) cache.delete(key);
      if (!force && cache.has(key)) {
        if (isStale(syncedAt.get(key), staleAfterMs)) refreshInBackground(options);
        return cache.get(key)!;
      }
      if (!force && deps.store) {
        const stored = await deps.store.read(options);
        if (stored) {
          cache.set(key, stored.inventory);
          syncedAt.set(key, Date.parse(stored.syncedAt));
          if (isStale(syncedAt.get(key), staleAfterMs)) refreshInBackground(options);
          return stored.inventory;
        }
        if (options.platform && options.platform !== "all") {
          const completeInventory = await deps.store.read({});
          if (completeInventory) {
            const projected = projectInventory(completeInventory.inventory, options.platform);
            cache.set(key, projected);
            syncedAt.set(key, Date.parse(completeInventory.syncedAt));
            if (isStale(syncedAt.get(key), staleAfterMs)) refreshInBackground({});
            return projected;
          }
        }
      }
      return refresh(options);
    },
    async sync(rawOptions?: WorkItemInventoryOptions): Promise<WorkItemInventoryResult> {
      return refresh(parseWorkItemInventoryOptions(rawOptions));
    },
    invalidate(): void {
      cache.clear();
      syncedAt.clear();
    },
  };

  async function refresh(options: WorkItemInventoryOptions): Promise<WorkItemInventoryResult> {
    const key = workItemInventoryKey(options);
    const inflight = refreshes.get(key);
    if (inflight) return inflight;
    const request = fetchRemote(options).then(async inventory => {
      if (inventory.complete) {
        const timestamp = new Date().toISOString();
        if (inventory.items.length > 0 || deps.store) cache.set(key, inventory);
        else cache.delete(key);
        syncedAt.set(key, Date.parse(timestamp));
        if (deps.store) await deps.store.write({ options, inventory, syncedAt: timestamp }).catch(() => undefined);
      } else {
        cache.delete(key);
        syncedAt.delete(key);
      }
      return inventory;
    }).finally(() => {
      refreshes.delete(key);
    });
    refreshes.set(key, request);
    return request;
  }

  function refreshInBackground(options: WorkItemInventoryOptions): void {
    void refresh(options).catch(() => undefined);
  }

  async function fetchRemote(options: WorkItemInventoryOptions): Promise<WorkItemInventoryResult> {
    const invocation = await deps.resolveAfk();
    if (!invocation.command) throw new BacklogServiceError("auth", "afk CLI 未在 PATH 中发现");
    const result = await deps.exec(invocation.command, [...invocation.args, ...inventoryArgs(options)], deps.cwd);
    if (!result.stdout) throw new BacklogServiceError("unknown", result.stderr || "afk inventory 未返回结果");
    const envelope = parseEnvelope(result.stdout);
    if (!envelope.ok) {
      const code = ["auth", "not_found", "validation", "provider"].includes(envelope.error.code) ? envelope.error.code : "unknown";
      throw new BacklogServiceError(code as "auth" | "not_found" | "validation" | "provider" | "unknown", envelope.error.message, envelope.error.details);
    }
    return parseWorkItemInventoryResult(envelope.data);
  }
}

function isStale(timestamp: number | undefined, staleAfterMs: number): boolean {
  return timestamp === undefined || !Number.isFinite(timestamp) || Date.now() - timestamp >= staleAfterMs;
}

function projectInventory(inventory: WorkItemInventoryResult, platform: "github" | "gitlab"): WorkItemInventoryResult {
  const items = inventory.items.filter(item => item.sources?.some(source => source.platform === platform) ?? item.project.platform === platform);
  return {
    ...inventory,
    items,
    projects: inventory.projects.filter(project => project.platform === platform),
    diagnostics: inventory.diagnostics.filter(diagnostic => diagnostic.platform === platform),
  };
}
