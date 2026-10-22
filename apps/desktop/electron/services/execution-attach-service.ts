import path from "node:path";
import type { ExecutionEnvironmentQueryResult } from "../../shared/execution-environment-contract.js";
import { formatTmuxTarget, tmuxTargetFromMetadata } from "../../shared/execution-environment-contract.js";

type ResourceRow = {
  id: string;
  kind: string;
  status: string;
  name: string;
  external_id: string | null;
  detail: string | null;
  workspace_path: string;
  run_id: string | null;
  worktree_path: string;
  metadata_json: string;
  updated_at: string;
};

type ResourceReader = (runId: string) => ResourceRow[];

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

  function parseMetadata(row: ResourceRow): Record<string, unknown> {
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  function toEnvironment(row: ResourceRow): ExecutionEnvironmentQueryResult {
    const metadata = parseMetadata(row);
    if (row.status !== "active") {
      return { available: false, unavailable: { resourceId: row.id, runId: row.run_id ?? undefined, reason: `执行环境状态为 ${row.status}，不可接管`, observedAt: row.updated_at } };
    }
    if (row.kind !== "tmux") {
      return { available: false, unavailable: { resourceId: row.id, runId: row.run_id ?? undefined, reason: `resource ${row.kind} 不支持终端接管`, observedAt: row.updated_at } };
    }
    const tmux = tmuxTargetFromMetadata(metadata);
    if (!tmux) {
      return { available: false, unavailable: { resourceId: row.id, runId: row.run_id ?? undefined, reason: "资源缺少已登记的 tmux 会话/窗口/窗格目标", observedAt: row.updated_at } };
    }
    return {
      available: true,
      environment: {
        resourceId: row.id,
        kind: "tmux",
        status: row.status as "active",
        name: row.name,
        worktreePath: path.resolve(row.worktree_path),
        workspacePath: path.resolve(row.workspace_path),
        ...(row.run_id ? { runId: row.run_id } : {}),
        tmux,
        observedAt: row.updated_at,
        ...(row.detail ? { detail: row.detail } : {}),
      },
    };
  }

  return {
    /** Resolve and validate the attach target for an exact runId. */
    async resolve(runId: string, resourceId?: string): Promise<ExecutionEnvironmentQueryResult & { attachTarget?: string }> {
      const rows = readRunResources(runId).filter(row => row.run_id === runId && (!resourceId || row.id === resourceId));
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
