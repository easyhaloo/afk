export type RuntimePhase = "ready" | "active" | "verify" | "attention";
export type RuntimeVisualState = RuntimePhase | "failed";
export type RuntimeProvider = "github" | "gitlab";

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
  source: string;
  timestamp: string;
};

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

export function runtimeWorkspacePath(nextStep: string): string | null {
  return nextStep.startsWith("任务空间：") ? nextStep.slice("任务空间：".length) : null;
}

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
