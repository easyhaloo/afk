import type { WorkItemPlatform } from "@afk/application";

export type RuntimePhase = "ready" | "active" | "verify" | "attention";
export type RuntimeVisualState = RuntimePhase | "failed";
export type RuntimeProvider = WorkItemPlatform;

export type RuntimeSourcePresentation = {
  provider?: RuntimeProvider;
  repository: string;
  workItem?: string;
};

export type RuntimeStateVisual = {
  icon: RuntimeVisualState;
  ariaLabel: string;
};

export type RuntimeEventLike = {
  id?: string;
  source: string;
  timestamp: string;
};

/**
 * The status a snapshot diagnostic records, read from the field the record
 * carries. The table is the whole vocabulary: an unrecognized record reads
 * as "queued" rather than being guessed at out of the record's prose.
 */
export type RecordStatus = "queued" | "running" | "waiting_confirmation" | "completed" | "failed";

export const recordStatusLabel: Record<RecordStatus, string> = {
  queued: "待执行",
  running: "运行中",
  waiting_confirmation: "待确认",
  completed: "已完成",
  failed: "失败",
};

const recordStatuses: Record<string, RecordStatus> = {
  waiting_confirmation: "waiting_confirmation",
  awaiting_confirmation: "waiting_confirmation",
  attention_required: "waiting_confirmation",
  hitl_requested: "waiting_confirmation",
  blocked: "waiting_confirmation",
  needs_confirmation: "waiting_confirmation",
  running: "running",
  active: "running",
  agent_exec: "running",
  tool_start: "running",
  in_progress: "running",
  completed: "completed",
  complete: "completed",
  success: "completed",
  verify_pass: "completed",
  passed: "completed",
  done: "completed",
  tool_result: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "failed",
  aborted: "failed",
  timed_out: "failed",
  queued: "queued",
  pending: "queued",
  created: "queued",
};

export function snapshotRecordStatus(event: { recordedStatus?: string }): RecordStatus {
  const recorded = String(event.recordedStatus ?? "").trim().toLowerCase().replaceAll("-", "_");
  return recordStatuses[recorded] ?? "queued";
}

export function searchRuntimeEvents<T extends RuntimeEventLike & { result: string; nextStep: string; recordedStatus?: string }>(events: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return events;
  return groupRuntimeEvents(events).filter(group => group.events.some(event => `${event.id ?? ""} ${event.source} ${event.recordedStatus ?? ""} ${event.result} ${event.nextStep}`.toLowerCase().includes(normalized))).flatMap(group => group.events);
}

export type RuntimeEventGroup<T extends RuntimeEventLike = RuntimeEventLike> = {
  source: string;
  events: T[];
};

export type RuntimeTerminalSession = {
  name: string;
  workspace: string;
};

const stateMeta: Record<RuntimeVisualState, RuntimeStateVisual> = {
  ready: { icon: "ready", ariaLabel: "待执行" },
  active: { icon: "active", ariaLabel: "执行中" },
  verify: { icon: "verify", ariaLabel: "已完成" },
  attention: { icon: "attention", ariaLabel: "待处理" },
  failed: { icon: "failed", ariaLabel: "失败" },
};

export function runtimeStateMeta(phase: RuntimeVisualState): RuntimeStateVisual {
  return stateMeta[phase];
}

/**
 * The legacy sentence form of a workspace path. The run centre reads the
 * workspace path from the run row's own field (see run-centre.ts); nothing on
 * the run centre's path calls this. It stays for the desktop's own contract
 * test, which pins the old record's shape.
 */
function normalizedWorkspacePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
}

export function findRuntimeTerminalSession(workspacePath: string | null, sessions: RuntimeTerminalSession[], fallbackWorkspace?: string): RuntimeTerminalSession | null {
  const target = workspacePath ? normalizedWorkspacePath(workspacePath) : "";
  if (target) {
    return sessions.find((session) => normalizedWorkspacePath(session.workspace) === target) ?? null;
  }
  if (!fallbackWorkspace) return null;
  const fallback = normalizedWorkspacePath(fallbackWorkspace);
  return sessions.find((session) => normalizedWorkspacePath(session.workspace) === fallback) ?? null;
}

export function groupRuntimeEvents<T extends RuntimeEventLike>(events: T[]): RuntimeEventGroup<T>[] {
  const grouped = new Map<string, T[]>();
  events.forEach((event) => grouped.set(event.source, [...(grouped.get(event.source) ?? []), event]));
  return [...grouped.entries()]
    .map(([source, sourceEvents]) => ({
      source,
      events: [...sourceEvents].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)),
    }))
    .sort((left, right) => Date.parse(right.events[0].timestamp) - Date.parse(left.events[0].timestamp));
}

export function parseRuntimeSource(source: string): RuntimeSourcePresentation {
  const trimmed = source.trim();
  const prefixMatch = trimmed.match(/^(github|gitlab):\s*/i);
  const provider = prefixMatch ? prefixMatch[1].toLowerCase() as RuntimeProvider : undefined;
  const withoutProvider = prefixMatch ? trimmed.slice(prefixMatch[0].length) : trimmed;
  const issueMatch = withoutProvider.match(/\s*(#\d+)$/);
  const repository = (issueMatch ? withoutProvider.slice(0, issueMatch.index) : withoutProvider).trim();
  return {
    provider,
    repository: repository || trimmed,
    ...(issueMatch ? { workItem: issueMatch[1] } : {}),
  };
}
