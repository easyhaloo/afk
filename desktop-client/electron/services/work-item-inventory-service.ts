import { BacklogServiceError } from "./backlog-error";
import {
  parseWorkItemInventoryOptions,
  parseWorkItemInventoryResult,
  type WorkItemInventoryOptions,
  type WorkItemInventoryResult,
} from "../../shared/backlog-contract";

export type AfkInvocation = { command: string; args: string[] };
export type WorkItemInventoryExecResult = { ok: boolean; stdout: string; stderr: string };

export type WorkItemInventoryServiceDeps = {
  resolveAfk: () => Promise<AfkInvocation>;
  runBundled?: (options: WorkItemInventoryOptions) => Promise<unknown>;
  cwd: string;
  exec: (command: string, args: string[], cwd: string) => Promise<WorkItemInventoryExecResult>;
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

  return {
    async list(rawOptions?: WorkItemInventoryOptions, force = false): Promise<WorkItemInventoryResult> {
      const options = parseWorkItemInventoryOptions(rawOptions);
      const key = JSON.stringify(options);
      if (force) cache.delete(key);
      if (!force && cache.has(key)) return cache.get(key)!;
      let inventory: WorkItemInventoryResult;
      if (deps.runBundled) {
        try {
          inventory = parseWorkItemInventoryResult(await deps.runBundled(options));
        } catch (error) {
          throw toServiceError(error);
        }
      } else {
        const invocation = await deps.resolveAfk();
        if (!invocation.command) throw new BacklogServiceError("auth", "afk CLI 未在 PATH 中发现");
        const result = await deps.exec(invocation.command, [...invocation.args, ...inventoryArgs(options)], deps.cwd);
        if (!result.stdout) throw new BacklogServiceError("unknown", result.stderr || "afk inventory 未返回结果");
        const envelope = parseEnvelope(result.stdout);
        if (!envelope.ok) {
          const code = ["auth", "not_found", "validation", "provider"].includes(envelope.error.code) ? envelope.error.code : "unknown";
          throw new BacklogServiceError(code as "auth" | "not_found" | "validation" | "provider" | "unknown", envelope.error.message, envelope.error.details);
        }
        inventory = parseWorkItemInventoryResult(envelope.data);
      }
      if (inventory.complete && inventory.items.length > 0) cache.set(key, inventory);
      else cache.delete(key);
      return inventory;
    },
    invalidate(): void {
      cache.clear();
    },
  };
}

function toServiceError(error: unknown): BacklogServiceError {
  if (error instanceof BacklogServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = normalized.includes("authentication") || normalized.includes("token") || normalized.includes("auth login")
    ? "auth"
    : normalized.includes("not found") || normalized.includes("404")
      ? "not_found"
      : normalized.includes("invalid") || normalized.includes("expected")
        ? "validation"
        : normalized.includes("api") || normalized.includes("http")
          ? "provider"
          : "unknown";
  return new BacklogServiceError(code, message);
}
