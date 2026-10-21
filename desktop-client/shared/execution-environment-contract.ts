import { normalizeTmuxSessionName } from "./tmux-session.js";

/**
 * Shared Application execution read model (ADR-0019 §1).
 *
 * Identities are distinct and never interchangeable:
 *   - workItemId: canonical work item across attempts
 *   - runId:      one execution attempt
 *   - stepId:     a step inside the run's workflow snapshot
 *   - resourceId: registered execution environment resource
 *   - session:    provider-native identity, which need not be a tmux session
 */
export type ExecutionEnvironmentKind = "tmux" | "container" | "isolate-service";

export type ExecutionEnvironmentStatus = "active" | "closed" | "missing" | "failed";

/** Exact registered tmux control target. A session name alone is not one. */
export type TmuxAttachTarget = {
  session: string;
  windowId?: string;
  windowName?: string;
  paneId?: string;
};

export type ExecutionEnvironment = {
  resourceId: string;
  kind: ExecutionEnvironmentKind;
  status: ExecutionEnvironmentStatus;
  name: string;
  worktreePath: string;
  workspacePath: string;
  /** Attempt this resource is associated with; empty when unlinked. */
  runId?: string;
  /** Full registered tmux target; present only for kind === "tmux". */
  tmux?: TmuxAttachTarget;
  observedAt: string;
  detail?: string;
};

export type ExecutionEnvironmentUnavailable = {
  resourceId?: string;
  runId?: string;
  reason: string;
  observedAt?: string;
};

export type ExecutionEnvironmentQueryResult =
  | { available: true; environment: ExecutionEnvironment }
  | { available: false; unavailable: ExecutionEnvironmentUnavailable };
/** `session:window.pane` form consumed by `tmux attach-session -t`. */
export function formatTmuxTarget(target: TmuxAttachTarget): string {
  const session = normalizeTmuxSessionName(target.session);
  if (target.windowId !== undefined) return `${session}:${target.windowId}.${target.paneId ?? "0"}`;
  if (target.windowName !== undefined) return `${session}:${target.windowName}${target.paneId ? `.${target.paneId}` : ""}`;
  return session;
}

/** Extract the registered tmux target from a resource metadata bag. */
export function tmuxTargetFromMetadata(metadata: Record<string, unknown>): TmuxAttachTarget | undefined {
  const session = metadata.tmuxSession;
  if (typeof session !== "string" || !session) return undefined;
  const target: TmuxAttachTarget = { session };
  if (typeof metadata.tmuxWindowId === "string") target.windowId = metadata.tmuxWindowId;
  if (typeof metadata.tmuxWindowName === "string") target.windowName = metadata.tmuxWindowName;
  if (typeof metadata.tmuxPaneId === "string") target.paneId = metadata.tmuxPaneId;
  return target;
}
