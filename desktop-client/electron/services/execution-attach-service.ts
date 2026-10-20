import path from "node:path";
import type { ExecutionEnvironmentQueryResult } from "../../shared/execution-environment-contract.js";
import { formatTmuxTarget, tmuxTargetFromMetadata } from "../../shared/execution-environment-contract.js";
import type { AfkResourceRecord } from "@afk/execution/infrastructure/runtime/resource-registry";

// The record the registry hands out, not a copy of its columns: the
// registry owns the table and the shape of what is in it.
type ResourceReader = (runId: string) => AfkResourceRecord[];

export type ExecutionAttachServiceDeps = {
  readRunResources?: ResourceReader;
  verifyTargetExists?: (target: string) => Promise<boolean>;
};

/**
 * ADR-0019 §4: attach targets come only from the registered resource record
 * for the exact runId. Historical records may be explicitly unavailable; the
 * service never guesses a target from a project directory or UI text.
 */
export function createExecutionAttachService(deps: ExecutionAttachServiceDeps = {}) {
  const readRunResources = deps.readRunResources ?? (() => []);
  const verifyTargetExists = deps.verifyTargetExists ?? (async () => false);

  function toEnvironment(row: AfkResourceRecord): ExecutionEnvironmentQueryResult {
    const metadata = row.metadata;
    if (row.status !== "active") {
      return { available: false, unavailable: { resourceId: row.id, runId: row.runId ?? undefined, reason: `执行环境状态为 ${row.status}，不可接管`, observedAt: row.updatedAt } };
    }
    if (row.kind !== "tmux") {
      return { available: false, unavailable: { resourceId: row.id, runId: row.runId ?? undefined, reason: `resource ${row.kind} 不支持终端接管`, observedAt: row.updatedAt } };
    }
    const tmux = tmuxTargetFromMetadata(metadata);
    if (!tmux) {
      return { available: false, unavailable: { resourceId: row.id, runId: row.runId ?? undefined, reason: "资源缺少已登记的 tmux 会话/窗口/窗格目标", observedAt: row.updatedAt } };
    }
    return {
      available: true,
      environment: {
        resourceId: row.id,
        kind: "tmux",
        status: row.status as "active",
        name: row.name,
        worktreePath: path.resolve(row.worktreePath),
        workspacePath: path.resolve(row.workspacePath),
        ...(row.runId ? { runId: row.runId } : {}),
        tmux,
        observedAt: row.updatedAt,
        ...(row.detail ? { detail: row.detail } : {}),
      },
    };
  }

  return {
    /** Resolve and validate the attach target for an exact runId. */
    async resolve(runId: string, resourceId?: string): Promise<ExecutionEnvironmentQueryResult & { attachTarget?: string }> {
      const rows = readRunResources(runId).filter(row => row.runId === runId && (!resourceId || row.id === resourceId));
      if (!rows.length) {
        return { available: false, unavailable: { runId, ...(resourceId ? { resourceId } : {}), reason: "该运行没有已登记的执行环境资源" } };
      }
      const resolved = rows.map(toEnvironment);
      const withTarget = resolved.filter((item): item is Extract<typeof item, { available: true }> => item.available && item.environment.tmux !== undefined);
      const unavailable = resolved.find(item => !item.available);
      for (const candidate of withTarget) {
        const target = formatTmuxTarget(candidate.environment.tmux!);
        const exists = await verifyTargetExists(target);
        if (exists) return { ...candidate, attachTarget: target };
      }
      if (withTarget.length) {
        const first = withTarget[0]!.environment;
        return { available: false, unavailable: { resourceId: first.resourceId, runId, reason: "已登记的 tmux 会话当前不存在（可能已退出）" } };
      }
      return unavailable ?? { available: false, unavailable: { runId, reason: "该运行没有可接管的执行环境" } };
    },
  };
}

export type ExecutionAttachService = ReturnType<typeof createExecutionAttachService>;
